import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { fetchSellados } from "@/lib/sellados";

// Cuánto le queda a un pago por repartir. La plata de un pago vive en DOS sitios,
// y la cuenta tiene que mirar los dos — es la misma que hace el chequeo de cuadre
// del pipeline (`entró = aplicado + disponible`):
//
//   restante = payment_amount − Σ pago_asociaciones.monto − Σ cartera_saldos_favor.disponible
//
// Sin el tercer término, un pago cuya plata quedó libre tras un descarte se ofrece
// ENTERO aunque ya esté comprometida en el ledger de saldos, y asociarlo desde acá
// la cuenta dos veces. Pasó el 12 de agosto con el pago `7780`: quedó una cuota de
// $400.000 con $800.000 aplicados desde un pago que trajo $400.000. Para mover esa
// plata el camino correcto es "Asociar saldo", que sí la descuenta.
const TOLERANCIA = 0.01;

async function restantePorPago(
  supabase: ReturnType<typeof createAdminClient>,
  matchingKeys: string[],
): Promise<{ restante: Map<string, number>; error: string | null }> {
  const restante = new Map<string, number>();
  // Por lotes y con `.in()`, por el mismo motivo que en lib/sellados.ts: una lista
  // larga puede volver cortada sin error, y aquí eso se traduce en ofrecer plata
  // que ya está repartida.
  for (let i = 0; i < matchingKeys.length; i += 200) {
    const lote = matchingKeys.slice(i, i + 200);

    const { data: asociaciones, error: asocError } = await supabase
      .from("pago_asociaciones")
      .select("matching_key, monto")
      .in("matching_key", lote);
    if (asocError) return { restante, error: asocError.message };
    for (const a of asociaciones ?? []) {
      restante.set(a.matching_key as string, (restante.get(a.matching_key as string) ?? 0) + Number(a.monto));
    }

    const { data: saldos, error: saldosError } = await supabase
      .from("cartera_saldos_favor")
      .select("matching_key, disponible")
      .in("matching_key", lote)
      .eq("aplicado", false)
      .gt("disponible", 0);
    if (saldosError) return { restante, error: saldosError.message };
    for (const s of saldos ?? []) {
      restante.set(s.matching_key as string, (restante.get(s.matching_key as string) ?? 0) + Number(s.disponible));
    }
  }
  return { restante, error: null };
}

// Panel de asociación manual (§4.1): dado un documento con 2+ inscripciones
// (distintas, no cuotas de la misma) con cuota pendiente, trae las
// inscripciones pendientes y los pagos de ese documento que todavía no se
// asociaron por completo (payment_amount menos lo ya comprometido).
// cruce_access en cartera_preventiva es el mismo documento que identification
// en consolidated_transactions (verificado con datos reales: doc 1004376520
// aparece igual en ambas tablas).
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const documento = searchParams.get("documento")?.trim();
  if (!documento) {
    return NextResponse.json({ error: "documento es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: inscripciones, error: insError } = await supabase
    .from("cartera_preventiva")
    .select("llave, inscrip, valor_a_cobrar, valor_cuota, sistema_financiero, fecha_vencimiento")
    .eq("cruce_access", documento)
    .is("fecha_pago", null);
  if (insError) return NextResponse.json({ error: insError.message }, { status: 500 });

  const { data: pagos, error: pagosError } = await supabase
    .from("consolidated_transactions")
    .select("matching_key, payment_amount, payment_date, transaction_code_1")
    .eq("identification", documento);
  if (pagosError) return NextResponse.json({ error: pagosError.message }, { status: 500 });

  const matchingKeys = (pagos || []).map((p) => p.matching_key as string);

  const { restante: comprometido, error: compError } = await restantePorPago(supabase, matchingKeys);
  if (compError) return NextResponse.json({ error: compError }, { status: 500 });

  // Un pago sellado no se ofrece: ya cerró su ventana de aplicación y el pipeline
  // no lo vuelve a mover. El sello vive en cruce_cartera, no en el consolidado.
  const { sellados, error: selError } = await fetchSellados(supabase, matchingKeys);
  if (selError) return NextResponse.json({ error: selError }, { status: 500 });

  const pagosConRestante = (pagos || [])
    .filter((p) => !sellados.has(p.matching_key as string))
    .map((p) => ({
      ...p,
      restante: Number(p.payment_amount) - (comprometido.get(p.matching_key as string) ?? 0),
    }))
    .filter((p) => p.restante > 0);

  return NextResponse.json({ inscripciones: inscripciones || [], pagos: pagosConRestante });
}

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey = body?.matching_key as string | undefined;
  const llave        = body?.llave as string | undefined;
  const monto         = Number(body?.monto);

  if (!matchingKey || !llave || !Number.isFinite(monto) || monto <= 0) {
    return NextResponse.json({ error: "matching_key, llave y monto (> 0) son requeridos" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Se revalida TODO en el servidor, sin confiar en lo que mande la pantalla. No es
  // redundante con el GET: el 12 de agosto el caso `7780` fueron dos botones distintos
  // con 14 segundos de diferencia sobre un panel que ya estaba desactualizado — el
  // primero escribió y el segundo sumó encima. Filtrar solo al listar no lo impide.
  const { data: pago, error: pagoError } = await supabase
    .from("consolidated_transactions")
    .select("matching_key, payment_amount")
    .eq("matching_key", matchingKey)
    .maybeSingle();
  if (pagoError) return NextResponse.json({ error: pagoError.message }, { status: 500 });
  if (!pago) {
    return NextResponse.json({ error: "No se encontró el pago en el consolidado." }, { status: 404 });
  }

  const { sellados, error: selError } = await fetchSellados(supabase, [matchingKey]);
  if (selError) return NextResponse.json({ error: selError }, { status: 500 });
  const selladoAt = sellados.get(matchingKey);
  if (selladoAt) {
    return NextResponse.json(
      { error: `Este pago ya cerró su ventana de aplicación (sellado el ${selladoAt}) y no se puede asociar.` },
      { status: 409 },
    );
  }

  const { restante: comprometido, error: compError } = await restantePorPago(supabase, [matchingKey]);
  if (compError) return NextResponse.json({ error: compError }, { status: 500 });
  const restante = Number(pago.payment_amount) - (comprometido.get(matchingKey) ?? 0);
  if (monto > restante + TOLERANCIA) {
    return NextResponse.json(
      {
        error: restante > 0
          ? `A este pago solo le quedan $${Math.round(restante).toLocaleString("es-CO")} por asociar.`
          : "Este pago ya no tiene plata libre: lo que quedaba está aplicado o convertido en saldo a favor. Para moverlo, usá \"Asociar saldo\".",
      },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from("pago_asociaciones")
    .insert({ matching_key: matchingKey, llave, monto, origen: "manual" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "insert",
    filters: { matching_key: matchingKey, llave, monto, view: "pago_asociaciones" },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
