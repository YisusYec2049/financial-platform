import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

// Regla #3 (Spec Auto Cartera): el botón "Descartar pago" necesita saber qué
// pago(s) están aplicados a una cuota ya cruzada — esa relación vive en
// pago_asociaciones (llave -> matching_key), cartera_preventiva no la guarda
// directamente. Se enriquece con transaction_code_1/payment_date de
// consolidated_transactions (best-effort, solo para mostrar contexto legible).
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const llave = searchParams.get("llave")?.trim();
  if (!llave) {
    return NextResponse.json({ error: "llave es requerida" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: asociaciones, error } = await supabase
    .from("pago_asociaciones")
    .select("id, matching_key, monto, origen, created_at")
    .eq("llave", llave);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!asociaciones || asociaciones.length === 0) return NextResponse.json({ data: [] });

  const matchingKeys = asociaciones.map((a) => a.matching_key);
  const { data: pagos } = await supabase
    .from("consolidated_transactions")
    .select("matching_key, transaction_code_1, payment_date")
    .in("matching_key", matchingKeys);

  const infoPorKey = new Map((pagos || []).map((p) => [p.matching_key, p]));
  const enriched = asociaciones.map((a) => ({
    ...a,
    transaction_code_1: infoPorKey.get(a.matching_key)?.transaction_code_1 ?? null,
    payment_date: infoPorKey.get(a.matching_key)?.payment_date ?? null,
  }));

  return NextResponse.json({ data: enriched });
}
