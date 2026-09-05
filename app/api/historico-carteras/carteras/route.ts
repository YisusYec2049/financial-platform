import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { CARTERA_VIVA } from "@/lib/historicoCarteras";

/**
 * Las opciones del selector: la cartera viva primero y las archivadas de más nueva a
 * más vieja.
 *
 * El conteo por cartera sale de la vista `cartera_historico_v` (una fila por carga_id,
 * con cuántas cuotas tiene y entre qué fechas cruzó). PostgREST no agrupa, y leer las
 * 11.602 filas del archivo en cada carga de la pantalla para contar sería absurdo.
 *
 * ⚠️ La tabla viva NO tiene `carga_id`, así que su opción se arma aparte: id literal
 * `viva`, y como fecha de inicio la fecha de archivo de la última cartera archivada
 * (que es el momento en que la viva empezó a existir). No se le inventa un carga_id.
 */
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();

  const [{ data: archivadas, error }, { count: cuotasVivas, error: errorVivas }] = await Promise.all([
    supabase
      .from("cartera_historico_v")
      .select("carga_id, fecha_archivo, cuotas, cuotas_con_cruce, cruce_desde, cruce_hasta")
      .order("fecha_archivo", { ascending: false }),
    supabase
      .from("cartera_preventiva")
      .select("id", { count: "exact", head: true }),
  ]);

  if (error)      return NextResponse.json({ error: error.message }, { status: 500 });
  if (errorVivas) return NextResponse.json({ error: errorVivas.message }, { status: 500 });

  const archivo = (archivadas || []).map((c) => ({
    id: c.carga_id as string,
    tipo: "archivo" as const,
    desde: c.carga_id as string,          // el carga_id ES el momento de la carga
    hasta: c.fecha_archivo as string,
    cuotas: (c.cuotas as number) ?? 0,
    cuotas_con_cruce: (c.cuotas_con_cruce as number) ?? 0,
    cruce_desde: (c.cruce_desde as string) ?? null,
    cruce_hasta: (c.cruce_hasta as string) ?? null,
  }));

  const viva = {
    id: CARTERA_VIVA,
    tipo: "viva" as const,
    // La viva empieza donde terminó la última archivada. Si no hubiera ninguna
    // archivada (base recién estrenada), queda null y la pantalla dice "Cartera actual".
    desde: archivo[0]?.hasta ?? null,
    hasta: null,
    cuotas: cuotasVivas ?? 0,
    cuotas_con_cruce: null,
    cruce_desde: null,
    cruce_hasta: null,
  };

  return NextResponse.json({ data: [viva, ...archivo] });
}
