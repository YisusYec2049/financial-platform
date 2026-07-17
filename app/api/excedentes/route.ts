import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Spec Sobrantes-Excedentes §4: modo B (última cuota) + sobra dinero = final,
// lo gestiona otra área — a diferencia de un Sobrante (§3), un Excedente no se
// vuelve a aplicar solo, por eso esta vista lleva descarga (requisito explícito
// del spec) en vez de solo lectura en pantalla.
export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search   = searchParams.get("search")?.slice(0, 100) || "";
  const page     = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize = 100;
  const offset   = (page - 1) * pageSize;

  const supabase = createAdminClient();
  let query = supabase
    .from("cartera_preventiva")
    .select("*", { count: "exact" })
    .eq("notificacion", "EXCEDENTE");

  if (search) {
    query = query.or(`cliente.ilike.%${search}%,inscrip.ilike.%${search}%`);
  }

  query = query
    .order("fecha_pago", { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, page, view: "cartera_preventiva_excedentes" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
