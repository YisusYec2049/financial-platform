import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search       = searchParams.get("search")?.slice(0, 100) || "";
  const estado       = searchParams.get("estado") || "todas";
  const vencFrom     = searchParams.get("venc_from") || "";
  const vencTo       = searchParams.get("venc_to") || "";
  const pagoParcial  = searchParams.get("pago_parcial") === "1";
  const medioPago    = searchParams.get("medio_pago")?.slice(0, 100) || "";
  const payFrom      = searchParams.get("pay_from") || "";
  const payTo        = searchParams.get("pay_to") || "";
  const cruceFrom    = searchParams.get("cruce_from") || "";
  const cruceTo      = searchParams.get("cruce_to") || "";
  const conNotificacion = searchParams.get("con_notificacion") === "1";
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

  if (estado === "resuelta") query = query.not("fecha_pago", "is", null);
  else if (estado === "pendiente") query = query.is("fecha_pago", null);

  if (vencFrom) query = query.gte("fecha_vencimiento", vencFrom);
  if (vencTo)   query = query.lte("fecha_vencimiento", vencTo);

  if (pagoParcial)  query = query.lt("diferencia", 0);
  if (medioPago)    query = query.eq("medio_pago", medioPago);
  if (payFrom)      query = query.gte("fecha_pago", payFrom);
  if (payTo)        query = query.lte("fecha_pago", payTo);
  if (cruceFrom)    query = query.gte("fecha_cruce", cruceFrom);
  if (cruceTo)      query = query.lte("fecha_cruce", cruceTo);
  if (conNotificacion) query = query.not("notificacion", "is", null).neq("notificacion", "");

  query = query
    .order("fecha_vencimiento", { ascending: true })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, page, view: "cartera_preventiva" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
