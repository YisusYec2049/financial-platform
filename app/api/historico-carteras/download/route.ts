import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  parseFiltrosHistorico,
  tablaDeCartera,
  aplicarFiltrosHistorico,
  ordenarHistorico,
} from "@/lib/historicoCarteras";

/**
 * La descarga del Histórico: las mismas filas de la pantalla, con los nombres de columna
 * crudos — `fecha_cruce` incluido, que es el campo con el que el área lleva su
 * seguimiento diario y el motivo del requerimiento.
 *
 * 🔴 Lee EXACTAMENTE lo mismo que la lista: filtros y selector salen del mismo helper
 * (lib/historicoCarteras.ts). Si esta ruta y la de la pantalla divergen, el Excel trae
 * un conjunto distinto del que la persona está viendo y no hay forma de notarlo.
 */
export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const filtros = parseFiltrosHistorico(searchParams);

  const supabase = createAdminClient();
  const tabla    = tablaDeCartera(filtros.cartera);
  const MAX_ROWS = 50_000;
  const BATCH    = 1000;
  let allData: Record<string, unknown>[] = [];
  let from = 0;

  while (allData.length < MAX_ROWS) {
    const batchSize = Math.min(BATCH, MAX_ROWS - allData.length);

    // La consulta se reconstruye en cada lote: un builder de supabase-js ya ejecutado
    // no sirve para pedir el rango siguiente.
    const base = supabase.from(tabla).select("*");
    const { data, error } = await ordenarHistorico(aplicarFiltrosHistorico(base, filtros))
      .range(from, from + batchSize - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    allData = allData.concat(data);
    if (data.length < batchSize) break;
    from += batchSize;
  }

  const truncated = allData.length >= MAX_ROWS;

  // Descarte de repetidos por `id` (la PK de las dos tablas), no por `llave`: la misma
  // llave vive a propósito en varias carteras, y dentro de una cartera una cuota cobrada
  // por partes son dos renglones legítimos.
  const seen = new Set<number>();
  const salida = allData.filter((row) => {
    const id = row.id as number;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { ...filtros, view: "historico_carteras" },
    result_count: salida.length,
  });

  return NextResponse.json({ data: salida, count: salida.length, truncated });
}
