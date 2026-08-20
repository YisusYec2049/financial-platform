import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";
import {
  parseFiltroDiferencia,
  OR_LE_FALTA_PLATA,
  gruposDeCuotas,
  filasPorLlave,
} from "@/lib/carteraDiferencia";

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
  const diferencia   = parseFiltroDiferencia(searchParams.get("diferencia"));

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
      // Desempate obligatorio: sin él se pierden filas EN SILENCIO. Hay 227 cuotas
      // con la misma fecha de vencimiento, y cuando el orden empata Postgres no
      // garantiza el mismo reparto en cada consulta: en el corte entre lotes unas
      // filas vienen dos veces (el dedup las descarta) y otras no vienen nunca.
      // Medido el 2026-08-05: esta descarga entregaba 3.017 de 3.032.
      .order("id", { ascending: true })
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

    // Filtro "Diferencia" (spec 2026-08-19), el mismo de la pantalla: el umbral de
    // "le falta plata" depende de la moneda de la cuota. Ver lib/carteraDiferencia.ts.
    if (diferencia === "falta") query = query.or(OR_LE_FALTA_PLATA);
    else if (diferencia === "sobra") query = query.gte("diferencia", 1);

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

  // Con el filtro de Diferencia puesto, el Excel tiene que traer lo mismo que la
  // pantalla: cada cuota que califica baja con sus líneas derivadas pegadas debajo
  // (una cuota de deuda recién nacida tiene la `diferencia` en NULL y por sí sola no
  // pasaría el filtro). Ver el camino agrupado de GET /api/cartera-preventiva.
  let salida = deduped;
  if (diferencia && deduped.length > 0) {
    const { grupos, error: gruposError } = await gruposDeCuotas(
      supabase,
      deduped.map((r) => ({ llave: (r.llave as string) ?? null, inscrip: (r.inscrip as string) ?? null })),
    );
    if (gruposError) return NextResponse.json({ error: gruposError }, { status: 500 });
    const llaves = grupos.flatMap((g) => g.filas.map((f) => f.llave));
    const { filas, error: filasError } = await filasPorLlave(supabase, llaves);
    if (filasError) return NextResponse.json({ error: filasError }, { status: 500 });
    const porLlave = new Map(filas.map((f) => [f.llave as string, f]));
    salida = llaves.map((ll) => porLlave.get(ll)).filter(Boolean) as Record<string, unknown>[];
  }

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, wompiTipo, multiCuota, diferencia, view: "cartera_preventiva" },
    result_count: salida.length,
  });

  return NextResponse.json({ data: salida, count: salida.length, truncated });
}
