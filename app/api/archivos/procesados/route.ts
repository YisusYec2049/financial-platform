import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

const PAGE_SIZE = 50;

/**
 * Las últimas corridas: qué archivo entró, cuándo, cuántas filas trajo, cuántos
 * pagos nuevos dejó y si terminó bien o con error.
 *
 * 🔴 **La columna de errores es el motivo de que esta tabla exista.** El atasco
 * de Stripe estuvo **un mes** fallando todos los días, con el vigilante
 * disparando la cadena cada 15 minutos, y nadie lo vio porque el único rastro
 * era un log en el servidor.
 *
 * Solo lectura: la escribe el pipeline (`utils/registro.py`) y desde la
 * pantalla no se borra ninguna fila (§9.7 de la spec) — el aviso de "este
 * archivo ya se procesó" tiene que valer para siempre, aunque el archivo caduque
 * a los 3 meses.
 */
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const fuente = searchParams.get("fuente") || "";
  const soloErrores = searchParams.get("solo_errores") === "1";

  try {
    const supabase = createAdminClient();
    let q = supabase
      .from("archivos_procesados")
      .select("*", { count: "exact" })
      .order("procesado_at", { ascending: false })
      // Desempate por la PK: sin él, en el corte entre páginas unas filas salen
      // dos veces y otras no salen nunca — y varias filas de una misma corrida
      // comparten `procesado_at` al segundo.
      .order("id", { ascending: false });

    if (fuente) q = q.eq("fuente", fuente);
    if (soloErrores) q = q.eq("resultado", "error");

    const desde = (page - 1) * PAGE_SIZE;
    const { data, error, count } = await q.range(desde, desde + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);

    return NextResponse.json({
      data: data ?? [],
      total: count ?? 0,
      pageSize: PAGE_SIZE,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo leer el registro." },
      { status: 502 }
    );
  }
}
