import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Enviar plata de una persona a OTRO documento.
//
// Un pago puede cubrir a dos personas distintas: una empresa que paga por un
// empleado, un familiar que paga por otro, un diplomado de dos cupos pagado de un
// solo giro. Hasta hoy la plata solo se podía mover DENTRO del documento del
// pagador — el reparto automático, el panel de "Asociar" y "Asociar saldo"
// emparejan los tres por documento (o correo) —, así que si el pago cubría a otra
// persona no había salida y terminaba saliendo por base de datos.
//
// UNA ruta para los DOS orígenes de la plata (spec del 19 de agosto, §3), porque
// son dos sitios distintos de donde puede salir y las dos funciones conviven:
//
//   { saldo_id, … }     → `trasladar_saldo_favor()`: plata que YA vive en el ledger
//                         (sobrantes y descartes). Es el camino del día a día —
//                         medidos 72 saldos vivos por $18.218.187 el 19 de agosto.
//   { matching_key, … } → `trasladar_saldo()`: plata que el pago nunca aplicó, la
//                         del panel de Asociar (41 pagos medidos el 18 de agosto).
//
// ⚠️ El segundo NO cubre al primero, y por eso hacen falta los dos: su fórmula
// (`payment_amount − aplicado − archivado − Σ disponible del ledger`) DESCUENTA el
// ledger, así que en cuanto el sobrante de un pago se vuelve saldo a favor el
// "libre" es cero y responde "a este pago no le queda nada". Y ese es el camino
// normal: el pipeline aplica el pago y anota el sobrante en la misma corrida.
//
// ⚠️ Toda la validación vive DENTRO de las funciones, no acá: es la lección del
// 12 de agosto (caso `7780`), donde dos clics con 14 segundos de diferencia sobre
// un panel ya desactualizado dejaron una cuota de $400.000 con $800.000 aplicados.
// Las funciones toman un candado por pago (`pg_advisory_xact_lock`) y releen la
// fila bloqueada, así que dos envíos simultáneos no pueden gastar lo mismo dos
// veces. Acá solo se pasa el mensaje tal cual: están escritos en lenguaje de
// proceso a propósito.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const saldoIdRaw        = body?.saldo_id;
  const matchingKey       = body?.matching_key as string | undefined;
  const documentoDestino  = (body?.documento_destino as string | undefined)?.trim();
  const monto             = Number(body?.monto);
  const saldoId           = saldoIdRaw == null ? null : Number(saldoIdRaw);

  if (!documentoDestino || !Number.isFinite(monto) || monto <= 0) {
    return NextResponse.json(
      { error: "documento_destino y monto (> 0) son requeridos" },
      { status: 400 },
    );
  }
  if (saldoId == null && !matchingKey) {
    return NextResponse.json(
      { error: "hace falta saldo_id (saldo a favor) o matching_key (restante del pago)" },
      { status: 400 },
    );
  }
  if (saldoId != null && !Number.isFinite(saldoId)) {
    return NextResponse.json({ error: "saldo_id inválido" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const desdeLedger = saldoId != null;

  // Solo para la bitácora: de quién sale la plata. No valida nada (de eso se
  // encargan las funciones), así que no importa que se lea fuera del candado.
  // En el camino del ledger el dueño es el de la FILA, no el del pago: una fila
  // que ya es fruto de un traslado pertenece a la persona destino, no al pagador.
  let documentoOrigen: string | null = null;
  if (desdeLedger) {
    const { data: saldo } = await supabase
      .from("cartera_saldos_favor")
      .select("documento, matching_key")
      .eq("id", saldoId)
      .maybeSingle();
    documentoOrigen = saldo?.documento ?? null;
  } else {
    const { data: pagoOrigen } = await supabase
      .from("consolidated_transactions")
      .select("identification")
      .eq("matching_key", matchingKey!)
      .maybeSingle();
    documentoOrigen = pagoOrigen?.identification ?? null;
  }

  const { data, error } = desdeLedger
    ? await supabase.rpc("trasladar_saldo_favor", {
        p_saldo_id:          saldoId,
        p_documento_destino: documentoDestino,
        p_monto:             monto,
      })
    : await supabase.rpc("trasladar_saldo", {
        p_matching_key:      matchingKey,
        p_documento_destino: documentoDestino,
        p_monto:             monto,
      });

  const filtrosBase = {
    saldo_id: saldoId,
    matching_key: matchingKey ?? null,
    documento_origen: documentoOrigen,
    documento_destino: documentoDestino,
    monto,
  };

  if (error) {
    // El fallo TAMBIÉN se registra: un error silencioso acá fue la mitad más
    // difícil del bug del descarte (27 de julio), donde la bitácora decía que
    // nadie había hecho nada.
    logAudit({
      user_email: user.email ?? "unknown",
      action: "insert",
      filters: {
        ...filtrosBase,
        view: desdeLedger ? "trasladar_saldo_favor" : "trasladar_saldo",
        error: error.message,
      },
      result_count: 0,
    });
    // Las validaciones de las funciones son todas "el estado de la base no permite
    // esto", no "el cuerpo viene mal": 409, y la pantalla muestra el mensaje.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  // Es la única acción del sistema que mueve plata de una persona a otra, así que
  // la bitácora tiene que decir quién lo hizo, de qué documento a cuál y por cuánto.
  logAudit({
    user_email: user.email ?? "unknown",
    action: "insert",
    filters: { ...filtrosBase, view: "cartera_saldos_favor (traslado)" },
    result_count: 1,
  });

  return NextResponse.json({ success: true, saldo: data });
}

// "Deshacer envío" vive en `enviar-saldo/deshacer` (POST), no acá.
//
// ⚠️ Hasta el 19 de agosto era un DELETE en esta misma ruta que **borraba la fila
// trasladada y nada más**. Eso solo era correcto mientras el único origen fuera el
// restante libre de un pago (ahí el restante se recalcula solo al desaparecer la
// fila). Con el traslado desde el ledger la plata sale de OTRA fila, a la que se
// le restó el monto: borrar sin devolvérselo **desaparece la plata de la base**.
// Por eso lo hace `deshacer_traslado_saldo()`, que mira `trasladado_de` y devuelve
// el monto a la fila de origen en la misma transacción.
