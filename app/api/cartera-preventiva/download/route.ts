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
  const conExcedente = searchParams.get("con_excedente") === "1";
  const medioPago    = searchParams.get("medio_pago")?.slice(0, 100) || "";
  const payFrom      = searchParams.get("pay_from") || "";
  const payTo        = searchParams.get("pay_to") || "";
  const cruceFrom    = searchParams.get("cruce_from") || "";
  const cruceTo      = searchParams.get("cruce_to") || "";
  const conNotificacion = searchParams.get("con_notificacion") === "1";

  const supabase = createAdminClient();
  const MAX_ROWS = 50_000;
  const BATCH = 1000;
  let allData: Record<string, unknown>[] = [];
  let from = 0;

  while (allData.length < MAX_ROWS) {
    const remaining = MAX_ROWS - allData.length;
    const batchSize = Math.min(BATCH, remaining);

    let query = supabase
      .from("cartera_preventiva")
      .select("*")
      .order("fecha_vencimiento", { ascending: true })
      .range(from, from + batchSize - 1);

    if (search) {
      query = query.or(`cliente.ilike.%${search}%,cruce_access.ilike.%${search}%`);
    }
    if (estado === "resuelta") query = query.not("fecha_pago", "is", null);
    else if (estado === "pendiente") query = query.is("fecha_pago", null);

    if (vencFrom) query = query.gte("fecha_vencimiento", vencFrom);
    if (vencTo)   query = query.lte("fecha_vencimiento", vencTo);

    if (pagoParcial)  query = query.lt("diferencia", 0);
    if (conExcedente) query = query.ilike("correo_elec", "%SOBRANTE%");
    if (medioPago)    query = query.eq("medio_pago", medioPago);
    if (payFrom)      query = query.gte("fecha_pago", payFrom);
    if (payTo)        query = query.lte("fecha_pago", payTo);
    if (cruceFrom)    query = query.gte("fecha_cruce", cruceFrom);
    if (cruceTo)      query = query.lte("fecha_cruce", cruceTo);
    if (conNotificacion) query = query.not("notificacion", "is", null).neq("notificacion", "");

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
    filters: { search, estado, vencFrom, vencTo, pagoParcial, conExcedente, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, view: "cartera_preventiva" },
    result_count: deduped.length,
  });

  return NextResponse.json({ data: deduped, count: deduped.length, truncated });
}
