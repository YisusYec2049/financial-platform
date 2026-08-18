import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Enviar el saldo de un pago a OTRO documento (spec del 18 de agosto).
//
// Un pago puede cubrir a dos personas distintas: una empresa que paga por un
// empleado, un familiar que paga por otro, una tesorería que manda un solo giro.
// Hasta hoy la plata solo se podía mover DENTRO del documento del pagador — el
// reparto automático, el panel de "Asociar" y "Asociar saldo" emparejan los tres
// por documento (o correo) —, así que si el pago cubría a otra persona no había
// salida y terminaba saliendo por base de datos. Medidos 41 pagos por $25.929.141
// cruzados contra una inscripción cuyo dueño es otro documento.
//
// Lo que se escribe es UNA fila en `cartera_saldos_favor` a nombre del documento
// DESTINO, y de ahí en adelante la recoge el botón "Asociar saldo" que ya existe.
// Son dos pasos a propósito: enviar y, allá, asociar a la cuota que corresponda.
//
// ⚠️ Toda la validación vive DENTRO de `trasladar_saldo()`, no acá: es la lección
// del 12 de agosto (caso `7780`), donde dos clics con 14 segundos de diferencia
// sobre un panel ya desactualizado dejaron una cuota de $400.000 con $800.000
// aplicados. La función además toma un candado por pago, así que dos envíos
// simultáneos del mismo restante no pueden escribir los dos.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey       = body?.matching_key as string | undefined;
  const documentoDestino  = (body?.documento_destino as string | undefined)?.trim();
  const monto             = Number(body?.monto);

  if (!matchingKey || !documentoDestino || !Number.isFinite(monto) || monto <= 0) {
    return NextResponse.json(
      { error: "matching_key, documento_destino y monto (> 0) son requeridos" },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Solo para la bitácora: de qué documento sale la plata. No valida nada (de eso
  // se encarga la función), así que no importa que se lea fuera del candado.
  const { data: pagoOrigen } = await supabase
    .from("consolidated_transactions")
    .select("identification")
    .eq("matching_key", matchingKey)
    .maybeSingle();

  const { data, error } = await supabase.rpc("trasladar_saldo", {
    p_matching_key:      matchingKey,
    p_documento_destino: documentoDestino,
    p_monto:             monto,
  });

  if (error) {
    // El fallo TAMBIÉN se registra: un error silencioso acá fue la mitad más
    // difícil del bug del descarte (27 de julio), donde la bitácora decía que
    // nadie había hecho nada.
    logAudit({
      user_email: user.email ?? "unknown",
      action: "insert",
      filters: {
        matching_key: matchingKey,
        documento_destino: documentoDestino,
        monto,
        view: "trasladar_saldo",
        error: error.message,
      },
      result_count: 0,
    });
    // Las 6 validaciones de la función son todas "el estado de la base no permite
    // esto", no "el cuerpo viene mal": 409, y la pantalla muestra el mensaje.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  // Es la única acción del sistema que mueve plata de una persona a otra, así que
  // la bitácora tiene que decir quién lo hizo, de qué documento a cuál y por cuánto.
  logAudit({
    user_email: user.email ?? "unknown",
    action: "insert",
    filters: {
      matching_key: matchingKey,
      documento_origen: pagoOrigen?.identification ?? null,
      documento_destino: documentoDestino,
      monto,
      view: "cartera_saldos_favor (traslado)",
    },
    result_count: 1,
  });

  return NextResponse.json({ success: true, saldo: data });
}

// "Deshacer envío": un documento mal escrito manda plata a la pantalla de un
// desconocido, y sin esto solo se saca por base de datos.
//
// Solo mientras NADIE lo haya asociado todavía (`origen='traslado'`,
// `aplicado=false` y `disponible = monto`, o sea intacto). Si ya se asoció algo,
// el camino es "Descartar pago" en la cuota destino, como siempre.
export async function DELETE(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const saldoId = Number(searchParams.get("saldo_id"));
  if (!Number.isFinite(saldoId)) {
    return NextResponse.json({ error: "saldo_id es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: saldo, error: readError } = await supabase
    .from("cartera_saldos_favor")
    .select("id, matching_key, documento, monto, disponible, aplicado, origen")
    .eq("id", saldoId)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!saldo) return NextResponse.json({ error: "No se encontró ese saldo." }, { status: 404 });

  if (saldo.origen !== "traslado") {
    return NextResponse.json(
      { error: "Este saldo no salió de un envío, así que no hay envío que deshacer." },
      { status: 409 },
    );
  }
  if (saldo.aplicado || Number(saldo.disponible) !== Number(saldo.monto)) {
    return NextResponse.json(
      {
        error:
          "Este saldo ya se asoció a una cuota (del todo o en parte), así que el envío no se puede deshacer. " +
          "Para devolverlo hay que usar \"Descartar pago\" en la cuota destino.",
      },
      { status: 409 },
    );
  }

  // El `disponible` leído entra en el WHERE: si alguien asoció una parte entre la
  // lectura y el borrado, el delete no alcanza ninguna fila y respondemos 409 en
  // vez de borrar un saldo que ya se estaba usando.
  const { data: borradas, error: delError } = await supabase
    .from("cartera_saldos_favor")
    .delete()
    .eq("id", saldoId)
    .eq("origen", "traslado")
    .eq("aplicado", false)
    .eq("disponible", saldo.disponible)
    .select("id");
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 });

  if (!borradas || borradas.length === 0) {
    logAudit({
      user_email: user.email ?? "unknown",
      action: "delete",
      filters: { saldo_id: saldoId, view: "cartera_saldos_favor (deshacer traslado)", error: "cambió antes de borrar" },
      result_count: 0,
    });
    return NextResponse.json(
      { error: "El saldo cambió mientras se deshacía el envío. Volvé a mirar la pantalla." },
      { status: 409 },
    );
  }

  logAudit({
    user_email: user.email ?? "unknown",
    action: "delete",
    filters: {
      saldo_id: saldoId,
      matching_key: saldo.matching_key,
      documento_destino: saldo.documento,
      monto: saldo.monto,
      view: "cartera_saldos_favor (deshacer traslado)",
    },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
