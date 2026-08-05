import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Reporte "WOMPI del día" — reporte de MÉTRICAS: cuánto se usa el link (automático)
// frente al pago manual. Por eso tiene que traer TODOS los WOMPI que entraron ese
// día, sin excepción.
//
// Lee `consolidated_transactions`, NO `cruce_cartera`: de esa tabla se borra un pago
// cuando se aparta (matrícula, cesantías, cheque…), así que el reporte perdía filas
// en silencio — medido el 23/07: 75 WOMPI entraron, el cruce solo veía 64, faltaban
// 11 por $9.050.627, todos marcados como matrícula.
//
// El día es la FECHA DE INGRESO (`registration_date`), no la fecha en que el cliente
// pagó (que suele ser días antes).
export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const regFrom = searchParams.get("reg_from") || "";
  const regTo   = searchParams.get("reg_to")   || "";

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
      .ilike("payment_method", "WOMPI%")
      .order("payment_date", { ascending: false })
      // Desempate obligatorio (ver cartera-preventiva/download): sin columna única
      // al final del orden, el corte entre lotes pierde filas en silencio.
      .order("matching_key", { ascending: true })
      .range(from, from + batchSize - 1);

    if (regFrom) query = query.gte("registration_date", regFrom);
    if (regTo)   query = query.lte("registration_date", regTo);

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
    const key = row.matching_key as string;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // El INCP no está en el consolidado. El pedido es traerlo "venga de donde venga":
  // NO se filtra por estado del cruce — hay pagos `pendiente` (Excepciones) con INCP
  // puesto a mano, y si solo se leyeran los `cruzado` el reporte los mostraría vacíos
  // (medidos 5 en el histórico). Y los pagos apartados se BORRAN de cruce_cartera a
  // propósito, así que su INCP solo puede salir de pagos_apartados.incp_resuelto.
  //
  // Nunca se deduce ni se rellena: si no hay dato, la celda va vacía.
  const llaves = deduped.map((r) => r.matching_key as string);
  const incpPorPago = new Map<string, string>();

  // Por lotes: un .in() con mil llaves puede volver cortado SIN error (la misma
  // trampa que la paginación). Y se pasa el arreglo a .in(), nunca interpolado
  // dentro de un .or(): postgrest-js entrecomilla solo las llaves con paréntesis
  // (`… (duplicado)`), que en un string de filtros romperían la consulta.
  for (let i = 0; i < llaves.length; i += 200) {
    const lote = llaves.slice(i, i + 200);

    const { data: cruce, error: cruceError } = await supabase
      .from("cruce_cartera")
      .select("matching_key, incp")
      .in("matching_key", lote);
    if (cruceError) return NextResponse.json({ error: cruceError.message }, { status: 500 });
    for (const r of cruce ?? []) {
      if (r.incp) incpPorPago.set(r.matching_key as string, r.incp as string);
    }

    const { data: apartados, error: apartadosError } = await supabase
      .from("pagos_apartados")
      .select("matching_key, incp_resuelto")
      .in("matching_key", lote);
    if (apartadosError) return NextResponse.json({ error: apartadosError.message }, { status: 500 });
    for (const r of apartados ?? []) {
      // cruce_cartera manda si el pago estuviera en las dos.
      if (r.incp_resuelto && !incpPorPago.has(r.matching_key as string)) {
        incpPorPago.set(r.matching_key as string, r.incp_resuelto as string);
      }
    }
  }

  // Vacío es "", no null: en el Excel se ven igual, pero el CSV escribiría "null".
  const conIncp = deduped.map((r) => ({
    ...r,
    incp: incpPorPago.get(r.matching_key as string) ?? "",
  }));

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { regFrom, regTo, view: "wompi_report" },
    result_count: conIncp.length,
  });

  return NextResponse.json({ data: conIncp, count: conIncp.length, truncated });
}
