import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";

/** Un `.in()` largo puede volver cortado sin error; se pregunta por lotes. */
const LOTE = 100;

export interface HuellaConocida {
  huella: string;
  nombre: string;
  fuente: string;
  procesado_at: string;
  pagos_nuevos: number | null;
  resultado: string;
}

/**
 * Dice cuáles de estas huellas YA se procesaron.
 *
 * Para qué: hoy volver a subir un PDF ya procesado **duplica los pagos en
 * silencio** —la llave del pago lleva el documento adentro, así que entran como
 * nuevos—. Es un agujero conocido y sin tapar.
 *
 * ⚠️ **Se compara por HUELLA, no por nombre.** Dos archivos distintos pueden
 * llamarse igual (`unified_payments (3).csv` se repite) y el mismo contenido
 * puede llegar con otro nombre.
 *
 * ⚠️ **Esto NO atrapa los repetidos de Stripe, y está bien**: ahí cada export
 * trae todo lo anterior más 3 o 4 pagos nuevos, así que la huella nunca
 * coincide. Esos pagos repetidos los descarta el pipeline por su llave.
 */
export async function POST(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const huellas: string[] = Array.isArray(body?.huellas)
    ? body.huellas.filter((h: unknown): h is string => typeof h === "string" && h.length > 0)
    : [];

  if (!huellas.length) return NextResponse.json({ conocidas: [] });

  try {
    const supabase = createAdminClient();
    const conocidas: HuellaConocida[] = [];

    for (let i = 0; i < huellas.length; i += LOTE) {
      const { data, error } = await supabase
        .from("archivos_procesados")
        .select("huella, nombre, fuente, procesado_at, pagos_nuevos, resultado")
        .in("huella", huellas.slice(i, i + LOTE))
        .order("procesado_at", { ascending: false });

      if (error) throw new Error(error.message);
      conocidas.push(...((data ?? []) as HuellaConocida[]));
    }

    // Una huella puede tener varias filas (se procesó más de una vez): se
    // devuelve la más reciente, que es la que se le enseña a la persona.
    const porHuella = new Map<string, HuellaConocida>();
    for (const c of conocidas) if (!porHuella.has(c.huella)) porHuella.set(c.huella, c);

    return NextResponse.json({ conocidas: [...porHuella.values()] });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo consultar el registro." },
      { status: 502 }
    );
  }
}
