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
      .order("registration_date", { ascending: false })
      .range(from, from + batchSize - 1);

    if (search) {
      query = query.or(
        `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%`
      );
    }
    if (paymentMethod) {
      query = paymentMethod.endsWith("%")
        ? query.ilike("payment_method", paymentMethod)
        : query.eq("payment_method", paymentMethod);
    }
    if (regFrom) query = query.gte("registration_date", regFrom);
    if (regTo)   query = query.lte("registration_date", regTo);
    if (payFrom) query = query.gte("payment_date", payFrom);
    if (payTo)   query = query.lte("payment_date", payTo);

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
    const id = row.id as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { search, paymentMethod, regFrom, regTo, payFrom, payTo },
    result_count: deduped.length,
  });

  return NextResponse.json({ data: deduped, count: deduped.length, truncated });
}
