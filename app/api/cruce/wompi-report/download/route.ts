import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Reporte "WOMPI del día": TODOS los WOMPI (identificados y no identificados),
// cualquier estado_cruce, filtrados solo por fecha de ingreso (registration_date).
// A diferencia de /api/cruce/download, NO aplica el filtro de estado, así que
// también incluye los `pendiente` (WOMPI no identificados de la pestaña Excepciones).
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
      .from("cruce_cartera")
      .select("*")
      .ilike("payment_method", "WOMPI%") // TODOS los WOMPI, cualquier estado_cruce
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
