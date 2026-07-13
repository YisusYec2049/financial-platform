import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cartera_preventiva")
    .select("convocatoria")
    .limit(10000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const unique = [...new Set(data.map((r: { convocatoria: string }) => r.convocatoria).filter(Boolean))].sort();
  return NextResponse.json(unique);
}
