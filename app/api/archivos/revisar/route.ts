import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

/**
 * ⚠️ **La URL va escrita a mano, como las otras 8.** No está en una variable de
 * entorno: así se decidió, y por eso la migración de servidor del 24 de agosto
 * pudo reutilizar el nombre de Tailscale en vez de tocar código.
 */
const REVISAR_URL = "https://srv1778161.tail6b87a9.ts.net/archivo/revisar";

/** Un Excel de 6 MB tarda unos segundos en abrirse; el default cortaría antes. */
const ESPERA_MS = 60_000;

/**
 * Vercel mata la función en su límite por defecto (10-15 s), que es **menos**
 * que lo que tarda abrir la cartera. Sin esto, el `AbortSignal` de arriba no
 * llegaría a usarse nunca en producción y la tarjeta quedaría siempre en "No se
 * pudo revisar" justo con los archivos grandes.
 */
export const maxDuration = 60;

/**
 * ¿El archivo que se acaba de subir sirve para la caja donde lo pusieron?
 *
 * 🔴 **La pantalla no revisa nada: pregunta.** Acá no hay —ni puede haber— una
 * lista de hojas, columnas o nombres esperados. Quien sabe si un archivo sirve
 * es el que lo va a leer: el endpoint del pipeline lo abre con **el mismo
 * lector** que lo va a procesar en la corrida.
 *
 * El 18 de septiembre el área le cambió el nombre a una hoja adentro del
 * archivo de Ingresos (`BANCOL 2833` → `PREBANCOLOMBIA 2833`) y el pipeline
 * estuvo **cuatro días** sin poder leerla. Una copia de los nombres de hoja
 * viviendo acá habría seguido pintando **verde** todo ese tiempo — un semáforo
 * que miente en verde es peor que no tener semáforo, porque el área le cree.
 *
 * ⚠️ **Solo viaja la RUTA del archivo, nunca el archivo.** Ya está en el
 * depósito —el navegador lo subió directo— y el pipeline lo baja de ahí.
 * Mandarlo en el cuerpo chocaría con el límite de ~4,5 MB de Vercel, que es
 * justo lo que los archivos de referencia superan.
 */
export async function POST(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const fuente = typeof body?.fuente === "string" ? body.fuente.trim() : "";
  const ruta = typeof body?.ruta === "string" ? body.ruta.trim() : "";

  if (!fuente || !ruta) {
    return NextResponse.json({ error: "Faltan 'fuente' y/o 'ruta'." }, { status: 400 });
  }

  try {
    const res = await fetch(REVISAR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TRIGGER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fuente, ruta }),
      cache: "no-store",
      signal: AbortSignal.timeout(ESPERA_MS),
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json(
        { error: json?.error || "No se pudo revisar el archivo" },
        { status: res.status }
      );
    }

    // El veredicto viaja tal cual: los tres estados, el `espera` ya escrito y
    // las filas leídas los decide el pipeline, no esta ruta.
    return NextResponse.json(json);
  } catch {
    // Incluye el timeout. La pantalla lo pinta en el estado neutro: un semáforo
    // caído no puede dejar al área sin poder trabajar.
    return NextResponse.json(
      { error: "No se pudo contactar el servicio de revisión" },
      { status: 502 }
    );
  }
}
