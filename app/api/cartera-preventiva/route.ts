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
  const wompiTipo    = searchParams.get("wompi_tipo") || "";
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
  // "Cerradas": pago_confirmado solo lo llena una persona al cerrar la cuota
  // ("Cerrar Cuota" por fila o "Cerrar Cartera" en bloque), así que distingue
  // una cuota cerrada de una que solo trae un abono del Excel.
  else if (estado === "cerrada") query = query.not("pago_confirmado", "is", null);

  if (vencFrom) query = query.gte("fecha_vencimiento", vencFrom);
  if (vencTo)   query = query.lte("fecha_vencimiento", vencTo);

  if (pagoParcial)  query = query.lt("diferencia", 0);
  if (medioPago) {
    if (medioPago.endsWith("%")) query = query.ilike("medio_pago", medioPago);
    else query = query.eq("medio_pago", medioPago);
  }
  if (payFrom)      query = query.gte("fecha_pago", payFrom);
  if (payTo)        query = query.lte("fecha_pago", payTo);
  if (cruceFrom)    query = query.gte("fecha_cruce", cruceFrom);
  if (cruceTo)      query = query.lte("fecha_cruce", cruceTo);
  // "Con notificación de pago de más": excluye 'FALTA DE PAGO', que es lo
  // contrario (la cuota original de un pago parcial con faltante >= $50k lleva
  // esa marca) y colaría aquí por ser una notificacion no nula.
  if (conNotificacion) query = query.not("notificacion", "is", null).neq("notificacion", "").neq("notificacion", "FALTA DE PAGO");

  // Filtro 2 (spec Wompi-Placetopay): solo se envía cuando el Filtro 1 = "Wompi"
  if (wompiTipo === "automatico") query = query.eq("es_wompi_automatico", true);
  else if (wompiTipo === "manual") query = query.eq("es_wompi_automatico", false);

  // Regla #5 (Spec Auto Cartera): una cuota "FALTA DE PAGO" hereda inscrip y
  // fecha_vencimiento de la cuota de la que se partió, así que ordenar por
  // (inscrip, fecha_vencimiento) la deja justo debajo de su padre por defecto.
  query = query
    .order("inscrip", { ascending: true })
    .order("fecha_vencimiento", { ascending: true })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, wompiTipo, page, view: "cartera_preventiva" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
