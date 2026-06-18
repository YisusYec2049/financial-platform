import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function GET(req: NextRequest) {
  // Autenticación
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search        = searchParams.get("search")?.slice(0, 100) || "";
  const paymentMethod = searchParams.get("payment_method")?.slice(0, 100) || "";
  const regFrom       = searchParams.get("reg_from") || "";
  const regTo         = searchParams.get("reg_to") || "";
  const payFrom       = searchParams.get("pay_from") || "";
  const payTo         = searchParams.get("pay_to") || "";
  const page          = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize      = 100;
  const offset        = (page - 1) * pageSize;

  const supabase = createAdminClient();
  let query = supabase
    .from("consolidated_transactions")
    .select("*", { count: "exact" });

  if (search) {
    query = query.or(
      `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%`
    );
  }

  if (paymentMethod) {
    if (paymentMethod.endsWith("%")) {
      query = query.ilike("payment_method", paymentMethod);
    } else {
      query = query.eq("payment_method", paymentMethod);
    }
  }

  if (regFrom) query = query.gte("registration_date", regFrom);
  if (regTo)   query = query.lte("registration_date", regTo);
  if (payFrom) query = query.gte("payment_date", payFrom);
  if (payTo)   query = query.lte("payment_date", payTo);

  query = query
    .order("registration_date", { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, paymentMethod, regFrom, regTo, payFrom, payTo, page },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
