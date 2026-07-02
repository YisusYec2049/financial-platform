import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

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
    .from("cruce_cartera")
    .select("*", { count: "exact" });

  if (search) {
    query = query.or(
      `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%`
    );
  }

  query = query
    .order("payment_date", { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, page, view: "cruce" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
