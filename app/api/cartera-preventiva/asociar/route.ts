import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Panel de asociación manual (§4.1): dado un documento con 2+ inscripciones
// (distintas, no cuotas de la misma) con cuota pendiente, trae las
// inscripciones pendientes y los pagos de ese documento que todavía no se
// asociaron por completo (payment_amount menos lo ya repartido en
// pago_asociaciones). cruce_access en cartera_preventiva es el mismo
// documento que identification en consolidated_transactions (verificado con
// datos reales: doc 1004376520 aparece igual en ambas tablas).
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

  const matchingKeys = (pagos || []).map((p) => p.matching_key);
  let asociado = new Map<string, number>();
  if (matchingKeys.length > 0) {
    const { data: asociaciones, error: asocError } = await supabase
      .from("pago_asociaciones")
      .select("matching_key, monto")
      .in("matching_key", matchingKeys);
    if (asocError) return NextResponse.json({ error: asocError.message }, { status: 500 });
    asociado = new Map();
    for (const a of asociaciones || []) {
      asociado.set(a.matching_key, (asociado.get(a.matching_key) ?? 0) + Number(a.monto));
    }
  }

  const pagosConRestante = (pagos || [])
    .map((p) => ({
      ...p,
      restante: Number(p.payment_amount) - (asociado.get(p.matching_key) ?? 0),
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
