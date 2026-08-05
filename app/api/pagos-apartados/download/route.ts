import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search  = sanitizeSearch(searchParams.get("search"));
  const tipo    = searchParams.get("tipo")?.slice(0, 50) || "";
  const regFrom = searchParams.get("reg_from") || "";
  const regTo   = searchParams.get("reg_to") || "";

  const supabase = createAdminClient();
  const MAX_ROWS = 50_000;
  const BATCH = 1000;
  let allData: Record<string, unknown>[] = [];
  let from = 0;

  while (allData.length < MAX_ROWS) {
    const remaining = MAX_ROWS - allData.length;
    const batchSize = Math.min(BATCH, remaining);

    let query = supabase
      .from("pagos_apartados")
      .select("*")
      .order("fecha_marcada", { ascending: false })
      // Desempate obligatorio (ver cartera-preventiva/download): sin columna única
      // al final del orden, el corte entre lotes pierde filas en silencio.
      // pagos_apartados NO tiene `id`; su PK es matching_key.
      .order("matching_key", { ascending: true })
      .range(from, from + batchSize - 1);

    if (search) {
      query = query.or(
        `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%,nota.ilike.%${search}%,matching_key.ilike.%${search}%`
      );
    }
    if (tipo) query = query.eq("tipo", tipo);
    if (regFrom) query = query.gte("fecha_ingreso", regFrom);
    if (regTo)   query = query.lte("fecha_ingreso", regTo);

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
    filters: { search, tipo, regFrom, regTo, view: "pagos_apartados" },
    result_count: deduped.length,
  });

  return NextResponse.json({ data: deduped, count: deduped.length, truncated });
}
