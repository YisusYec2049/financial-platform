import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Reporte "WOMPI del día" — reporte de MÉTRICAS: cuánto se usa el link (automático)
// frente al pago manual. Por eso tiene que traer TODOS los WOMPI que entraron ese
// día, sin excepción.
//
// Lee `consolidated_transactions`, NO `cruce_cartera`: de esa tabla se borra un pago
// cuando se aparta (matrícula, cesantías, cheque…), así que el reporte perdía filas
// en silencio — medido el 23/07: 75 WOMPI entraron, el cruce solo veía 64, faltaban
// 11 por $9.050.627, todos marcados como matrícula.
//
// El día es la FECHA DE INGRESO (`registration_date`), no la fecha en que el cliente
// pagó (que suele ser días antes).
export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const regFrom = searchParams.get("reg_from") || "";
  const regTo   = searchParams.get("reg_to")   || "";

  const supabase = createAdminClient();
  const MAX_ROWS = 50_000;
  const BATCH = 1000;
  let allData: Record<string, unknown>[] = [];
  let from = 0;

  while (allData.length < MAX_ROWS) {
    const remaining = MAX_ROWS - allData.length;
    const batchSize = Math.min(BATCH, remaining);

    let query = supabase
      .from("consolidated_transactions")
      .select("*")
      .ilike("payment_method", "WOMPI%")
      .order("payment_date", { ascending: false })
      .range(from, from + batchSize - 1);

    if (regFrom) query = query.gte("registration_date", regFrom);
    if (regTo)   query = query.lte("registration_date", regTo);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    allData = allData.concat(data);
    if (data.length < batchSize) break;
    from += batchSize;
  }

  const truncated = allData.length >= MAX_ROWS;

  const seen = new Set<string>();
  const deduped = allData.filter((row) => {
    const key = row.matching_key as string;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { regFrom, regTo, view: "wompi_report" },
    result_count: deduped.length,
  });

  return NextResponse.json({ data: deduped, count: deduped.length, truncated });
}
