import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search")?.slice(0, 100) || "";

  const supabase = createAdminClient();
  const MAX_ROWS = 50_000;
  const BATCH = 1000;
  let allData: Record<string, unknown>[] = [];
  let from = 0;

  while (allData.length < MAX_ROWS) {
    const remaining = MAX_ROWS - allData.length;
    const batchSize = Math.min(BATCH, remaining);

    let query = supabase
      .from("cartera_preventiva")
      .select("*")
      .eq("notificacion", "EXCEDENTE")
      .order("fecha_pago", { ascending: false })
      .range(from, from + batchSize - 1);

    if (search) {
      query = query.or(`cliente.ilike.%${search}%,inscrip.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    allData = allData.concat(data);
    if (data.length < batchSize) break;
    from += batchSize;
  }

  const truncated = allData.length >= MAX_ROWS;

  const seen = new Set<number>();
  const deduped = allData.filter((row) => {
    const id = row.id as number;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { search, view: "cartera_preventiva_excedentes" },
    result_count: deduped.length,
  });

  return NextResponse.json({ data: deduped, count: deduped.length, truncated });
}
