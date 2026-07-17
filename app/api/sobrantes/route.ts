import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Spec Sobrantes-Excedentes §3: cartera_saldos_favor la mantiene matching-test
// sola — cuando el pipeline consume un sobrante (lo aplica al próximo archivo)
// pone aplicado=true y la fila sale de esta vista sin intervención de esta app.
// Esta vista es de solo lectura, gemelo estructural de Pagos Apartados.
export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search")?.slice(0, 100) || "";
  const sort   = searchParams.get("sort") === "monto" ? "monto" : "fecha";
  const order  = searchParams.get("order") === "asc";
  const page     = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize = 100;
  const offset   = (page - 1) * pageSize;

  const supabase = createAdminClient();
  let query = supabase
    .from("cartera_saldos_favor")
    .select("*", { count: "exact" })
    .eq("aplicado", false);

  if (search) {
    query = query.or(`inscrip.ilike.%${search}%,cliente.ilike.%${search}%`);
  }

  query = query
    .order(sort, { ascending: order })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, sort, order, page, view: "cartera_saldos_favor" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
