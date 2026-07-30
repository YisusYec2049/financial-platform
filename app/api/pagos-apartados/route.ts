import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search   = sanitizeSearch(searchParams.get("search"));
  const tipo     = searchParams.get("tipo")?.slice(0, 50) || "";
  const regFrom  = searchParams.get("reg_from") || "";
  const regTo    = searchParams.get("reg_to") || "";
  const page     = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize = 100;
  const offset   = (page - 1) * pageSize;

  const supabase = createAdminClient();
  let query = supabase
    .from("pagos_apartados")
    .select("*", { count: "exact" });

  if (search) {
    query = query.or(
      `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%,nota.ilike.%${search}%,matching_key.ilike.%${search}%`
    );
  }

  if (tipo) query = query.eq("tipo", tipo);
  if (regFrom) query = query.gte("fecha_ingreso", regFrom);
  if (regTo)   query = query.lte("fecha_ingreso", regTo);

  query = query
    .order("fecha_marcada", { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, tipo, regFrom, regTo, page, view: "pagos_apartados" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}

export async function PATCH(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey  = body?.matching_key as string | undefined;
  const incpResuelto = typeof body?.incp_resuelto === "string" ? body.incp_resuelto : null;

  if (!matchingKey) {
    return NextResponse.json({ error: "matching_key es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: existing, error: fetchError } = await supabase
    .from("pagos_apartados")
    .select("tipo")
    .eq("matching_key", matchingKey)
    .maybeSingle();

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (existing?.tipo === "cheque") {
    return NextResponse.json({ error: "Los cheques no vuelven al proceso — no tienen INCP editable" }, { status: 400 });
  }

  const { error, data } = await supabase
    .from("pagos_apartados")
    .update({ incp_resuelto: incpResuelto })
    .eq("matching_key", matchingKey)
    .select("matching_key");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "update",
    filters: { matching_key: matchingKey, incp_resuelto: incpResuelto, view: "pagos_apartados" },
    result_count: data?.length ?? 0,
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const matchingKey = searchParams.get("matching_key");

  if (!matchingKey) {
    return NextResponse.json({ error: "matching_key es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error, data } = await supabase
    .from("pagos_apartados")
    .delete()
    .eq("matching_key", matchingKey)
    .select("matching_key");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "delete",
    filters: { matching_key: matchingKey, view: "pagos_apartados" },
    result_count: data?.length ?? 0,
  });

  return NextResponse.json({ success: true });
}
