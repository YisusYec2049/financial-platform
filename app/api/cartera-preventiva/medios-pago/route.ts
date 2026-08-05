import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();

  // PostgREST cabecea las filas devueltas (max-rows) sin importar el .limit()
  // pedido, así que un solo select traía siempre las primeras ~1000 filas por
  // orden de inserción — como esas primeras filas son mayormente pendientes
  // (medio_pago null), el dropdown salía vacío. Se pagina hasta agotar la tabla.
  const BATCH = 1000;
  const values = new Set<string>();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("cartera_preventiva")
      .select("medio_pago")
      // Sin ORDER BY, Postgres puede cambiar de reparto entre un lote y el
      // siguiente y perder filas: acá eso sería un medio de pago que desaparece
      // del dropdown sin explicación.
      .order("id", { ascending: true })
      .range(from, from + BATCH - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    for (const row of data as { medio_pago: string | null }[]) {
      if (row.medio_pago) values.add(row.medio_pago);
    }

    if (data.length < BATCH) break;
    from += BATCH;
  }

  return NextResponse.json([...values].sort());
}
