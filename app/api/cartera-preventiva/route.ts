import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search       = searchParams.get("search")?.slice(0, 100) || "";
  const convocatoria = searchParams.get("convocatoria")?.slice(0, 100) || "";
  const estado       = searchParams.get("estado") || "todas";
  const vencFrom     = searchParams.get("venc_from") || "";
  const vencTo       = searchParams.get("venc_to") || "";
  const page          = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize      = 100;
  const offset        = (page - 1) * pageSize;

  const supabase = createAdminClient();
  let query = supabase
    .from("cartera_preventiva")
    .select("*", { count: "exact" });

  if (search) {
    query = query.or(`cliente.ilike.%${search}%,cruce_access.ilike.%${search}%`);
  }

  if (convocatoria) query = query.eq("convocatoria", convocatoria);

  if (estado === "resuelta") query = query.not("fecha_pago", "is", null);
  else if (estado === "pendiente") query = query.is("fecha_pago", null);

  if (vencFrom) query = query.gte("fecha_vencimiento", vencFrom);
  if (vencTo)   query = query.lte("fecha_vencimiento", vencTo);

  query = query
    .order("fecha_vencimiento", { ascending: true })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, convocatoria, estado, vencFrom, vencTo, page, view: "cartera_preventiva" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
