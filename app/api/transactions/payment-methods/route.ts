import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("get_distinct_payment_methods");

  if (error) {
    const { data: fallback, error: err2 } = await supabase
      .from("consolidated_transactions")
      .select("payment_method")
      .limit(100000);

    if (err2) return NextResponse.json({ error: err2.message }, { status: 500 });

    const unique = [...new Set(fallback.map((r: { payment_method: string }) => r.payment_method).filter(Boolean))].sort();
    return NextResponse.json(unique);
  }

  const unique = (data as { payment_method: string }[]).map((r) => r.payment_method).sort();
  return NextResponse.json(unique);
}
