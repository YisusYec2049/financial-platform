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
  const page          = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize      = 100;
  const offset        = (page - 1) * pageSize;

  const supabase = createAdminClient();

  // `cartera_preventiva_v` = la tabla + la columna calculada `cuotas_inscripcion`.
  // Solo lectura: todas las escrituras siguen apuntando a la tabla.
  //
  // La anotación `typeof base` corta la inferencia en cada paso: sin ella, encadenar
  // ~14 filtros condicionales hace explotar el tipo del builder (TS2589).
  const aplicarFiltros = (columnas: string, exact: boolean) => {
    const base = supabase
      .from("cartera_preventiva_v")
      .select(columnas, exact ? { count: "exact" } : undefined);
    let query: typeof base = base;

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

    // Filtro 2 (spec Wompi-Placetopay): solo se envía cuando el Filtro 1 = "Wompi"
    if (wompiTipo === "automatico") query = query.eq("es_wompi_automatico", true);
    else if (wompiTipo === "manual") query = query.eq("es_wompi_automatico", false);

    // "Inscripciones con varias cuotas": cuenta CUOTAS, no renglones — una cuota
    // cobrada por partes ("llave" + "llave (fecha)") cuenta como una sola. El conteo
    // lo trae la vista, calculado sobre TODA la cartera: que la persona ponga un
    // rango de fechas no cambia cuántas cuotas debe la inscripción.
    if (multiCuota) query = query.gt("cuotas_inscripcion", 1);

    // Filtro "Diferencia" (spec 2026-08-19). El umbral de "le falta plata" depende de
    // la moneda de la cuota — ver lib/carteraDiferencia.ts.
    if (diferencia === "falta") query = query.or(OR_LE_FALTA_PLATA);
    else if (diferencia === "sobra") query = query.gte("diferencia", 1);

    // Regla #5 (Spec Auto Cartera): una cuota "FALTA DE PAGO" hereda inscrip y
    // fecha_vencimiento de la cuota de la que se partió, así que ordenar por
    // (inscrip, fecha_vencimiento) la deja justo debajo de su padre por defecto.
    // El desempate por `id` es obligatorio (ver GET /api/cruce): sin columna única al
    // final del orden, hay filas que no salen en ninguna página.
    return query
      .order("inscrip", { ascending: true })
      .order("fecha_vencimiento", { ascending: true })
      .order("id", { ascending: true });
  };

  let data: Record<string, unknown>[] = [];
  let count: number | null = 0;
  // Cuando el filtro de Diferencia está puesto, `count` cuenta CUOTAS y `renglones`
  // cuenta las filas que se ven (cada cuota arrastra sus líneas derivadas).
  let renglones: number | null = null;

  if (diferencia) {
    // ── Camino agrupado (§3/§4 del spec) ───────────────────────────────────────
    // Una cuota de deuda recién nacida tiene la `diferencia` en NULL, así que el
    // filtro traería la madre y dejaría la hija afuera. Regla: si la madre entra,
    // entran sus hijas; si una hija entra, entra su madre — y se muestran juntas.
    //
    // 🔴 Se pagina por CUOTA, no por renglón. Si la página se cortara contando
    // renglones, una madre podría quedar al final de una página y su hija al
    // principio de la siguiente, y ahí el filtro miente: se ve una deuda suelta sin
    // la cuota que la explica. Es lo mismo que se resolvió el 19/08 con el pago
    // compartido en Cruce (se paginan los grupos, los renglones viajan pegados).
    const MAX_CUOTAS = 20_000;
    const LOTE = 1000;
    const calificadas: { llave: string | null; inscrip: string | null }[] = [];
    for (let desde = 0; desde < MAX_CUOTAS; desde += LOTE) {
      const { data: lote, error } = await aplicarFiltros("llave, inscrip", false)
        .range(desde, desde + LOTE - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const filas = (lote || []) as unknown as { llave: string | null; inscrip: string | null }[];
      calificadas.push(...filas);
      if (filas.length < LOTE) break;
    }

    const { grupos, error: gruposError } = await gruposDeCuotas(supabase, calificadas);
    if (gruposError) return NextResponse.json({ error: gruposError }, { status: 500 });

    count = grupos.length;
    renglones = grupos.reduce((n, g) => n + g.filas.length, 0);

    const pagina = grupos.slice(offset, offset + pageSize);
    const llaves = pagina.flatMap((g) => g.filas.map((f) => f.llave));
    const { filas, error: filasError } = await filasPorLlave(supabase, llaves);
    if (filasError) return NextResponse.json({ error: filasError }, { status: 500 });

    // El orden lo pone el grupo, no la base: la respuesta de `.in()` no lo garantiza.
    const porLlave = new Map(filas.map((f) => [f.llave as string, f]));
    data = llaves.map((ll) => porLlave.get(ll)).filter(Boolean) as Record<string, unknown>[];
  } else {
    const { data: filas, error, count: total } = await aplicarFiltros("*", true)
      .range(offset, offset + pageSize - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    data = (filas || []) as unknown as Record<string, unknown>[];
    count = total ?? 0;
  }

  // Una "línea de deuda" (la que abre el pipeline cuando alguien paga de menos y
  // faltan >= $50k) no es una cuota independiente: es el reflejo de la `diferencia`
  // de su cuota original, y el pipeline la baja sola a medida que la original
  // recibe plata. Mientras la original siga abierta la plata va EN LA ORIGINAL, así
  // que ofrecer "Asociar" acá pagaría la misma deuda dos veces. Se independiza
  // recién cuando la original se cierra (`pago_confirmado` no nulo, que solo lo
  // escribe una persona con "Cerrar Cuota" / "Cerrar Cartera").
  //
  // Se reconoce por la llave: la de la original + un sufijo entre paréntesis
  // ("3339PN46237" -> "3339PN46237 (2026-07-29)"). La original puede caer fuera de
  // la página, así que hay que resolverlo acá y no en el frontend.
  // ⚠️ SOLO el paréntesis, a diferencia de `raizDeCuota` (lib/carteraDiferencia.ts),
  // que también entiende el sufijo " 2" del Excel: esa partición no la hace el
  // pipeline y no es una línea de deuda, así que tratarla como tal le quitaría el
  // botón de asociar sin motivo.
  const baseDeLlave = (llave: string) => {
    const i = llave.lastIndexOf(" (");
    return i > 0 ? llave.slice(0, i) : "";
  };
  const bases = [...new Set(data.map((r) => baseDeLlave((r.llave as string) || "")).filter(Boolean))];
  const abiertaPorLlave = new Map<string, boolean>();
  if (bases.length > 0) {
    const { data: originales } = await supabase
      .from("cartera_preventiva")
      .select("llave, pago_confirmado")
      .in("llave", bases);
    for (const o of originales || []) abiertaPorLlave.set(o.llave, o.pago_confirmado == null);
  }

  const enriched = data.map((row) => ({
    ...row,
    // false también cuando no es línea de deuda o cuando la original ya no existe.
    original_abierta: abiertaPorLlave.get(baseDeLlave((row.llave as string) || "")) === true,
  }));

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, wompiTipo, multiCuota, diferencia, page, view: "cartera_preventiva" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data: enriched, count, renglones, page, pageSize });
}
