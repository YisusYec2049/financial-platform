import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search       = sanitizeSearch(searchParams.get("search"));
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
  const multiCuota   = searchParams.get("multi_cuota") === "1";

  const supabase = createAdminClient();
  const MAX_ROWS = 50_000;
  const BATCH = 1000;
  let allData: Record<string, unknown>[] = [];
  let from = 0;

  while (allData.length < MAX_ROWS) {
    const remaining = MAX_ROWS - allData.length;
    const batchSize = Math.min(BATCH, remaining);

    // La vista, igual que la pantalla: trae `cuotas_inscripcion` como columna extra
    // (se deja a propósito en el Excel) y permite el filtro de varias cuotas.
    let query = supabase
      .from("cartera_preventiva_v")
      .select("*")
      .order("fecha_vencimiento", { ascending: true })
      .range(from, from + batchSize - 1);

    if (search) {
      query = query.or(`cliente.ilike.%${search}%,cruce_access.ilike.%${search}%,codigo_transaccion_1.ilike.%${search}%,inscrip.ilike.%${search}%`);
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

    if (wompiTipo === "automatico") query = query.eq("es_wompi_automatico", true);
    else if (wompiTipo === "manual") query = query.eq("es_wompi_automatico", false);

    // Ver comentario en GET /api/cartera-preventiva: cuenta cuotas, no renglones.
    if (multiCuota) query = query.gt("cuotas_inscripcion", 1);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    allData = allData.concat(data);
    if (data.length < batchSize) break;
    from += batchSize;
  }

  const truncated = allData.length >= MAX_ROWS;

  const seen = new Set<number>();
  const deduped = allData.filter((row) => {
    const id = row.id as number;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, wompiTipo, multiCuota, view: "cartera_preventiva" },
    result_count: deduped.length,
  });

  return NextResponse.json({ data: deduped, count: deduped.length, truncated });
}
