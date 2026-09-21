import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/server";
import { BUCKET, REVISION, esFuenteValida, rutaEntrada } from "@/lib/fuentes";

/**
 * El apartado de revisión: donde vive un archivo **recién soltado**, mientras el
 * pipeline contesta si sirve y antes de que nadie apriete "Subir".
 *
 * 🔴 **El pipeline no lista `revision/` nunca** (`utils/deposito.py:listar()`
 * mira solo `entrada/<fuente>/`), así que un archivo acá no existe para la
 * corrida. Es lo que permite revisarlo **antes** de que entre: la revisión la
 * hace el pipeline leyendo el archivo del depósito, y para eso tiene que estar
 * subido en algún lado — pero no en la bandeja.
 *
 * `POST`   mueve `revision/… → entrada/…` con su nombre final (el lote incluido).
 * `DELETE` borra la copia del apartado, que es lo que hace la ✕ de la tarjeta.
 */

/** Toda ruta del apartado es `revision/<fuente>/<archivo>`, plana y con fuente válida. */
function rutaDeRevisionValida(ruta: string): boolean {
  const partes = ruta.split("/");
  return partes.length === 3 && partes[0] === REVISION && esFuenteValida(partes[1]) && !!partes[2];
}

/**
 * Sube de verdad un archivo ya soltado: lo **mueve** del apartado a la bandeja.
 *
 * 🔴 **Se mueve, no se vuelve a subir.** El archivo viaja una sola vez desde el
 * navegador —que es lo que esquiva el límite de ~4,5 MB de Vercel, el mismo
 * motivo por el que la subida va directa al depósito con una URL firmada—. Acá
 * solo viajan nombres.
 *
 * El nombre final se arma en el DESTINO, no antes: el lote de PayU se decide
 * sobre la tanda que se sube junta, o sea recién ahora.
 *
 * Deja la misma constancia que dejaba `registrar` (`action: 'subir_archivo'`),
 * que es de donde sale "quién lo subió" en la lista de la bandeja —
 * `archivos_procesados` la llena el pipeline y no puede saberlo.
 */
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const desde = typeof body?.desde === "string" ? body.desde.trim() : "";
  const fuente = typeof body?.fuente === "string" ? body.fuente.trim() : "";
  const nombre = typeof body?.nombre === "string" ? body.nombre.trim() : "";
  const huella = typeof body?.huella === "string" ? body.huella.trim() : "";
  const lote = typeof body?.lote === "string" && body.lote.trim() ? body.lote.trim() : null;
  const tamano = typeof body?.tamano === "number" ? body.tamano : null;

  if (!rutaDeRevisionValida(desde) || !esFuenteValida(fuente) || !nombre) {
    return NextResponse.json({ error: "Datos de la subida incompletos." }, { status: 400 });
  }
  if (nombre.includes("/")) {
    return NextResponse.json({ error: "El nombre del archivo no puede contener '/'." }, { status: 400 });
  }
  // El separador de lote es del pipeline (`split('__', 1)`): un `__` adentro del
  // identificador partiría el lote y el par de PayU dejaría de emparejarse.
  if (lote && lote.includes("__")) {
    return NextResponse.json({ error: "El lote no puede contener '__'." }, { status: 400 });
  }

  const hacia = rutaEntrada(fuente, nombre, lote);

  try {
    const supabase = createAdminClient();
    let { error } = await supabase.storage.from(BUCKET).move(desde, hacia);

    // `move` falla si el destino ya existe, mientras la subida directa usaba
    // `upsert: true` — o sea que volver a subir un archivo con el mismo nombre
    // lo reemplazaba. Se conserva ese comportamiento: se borra el de la bandeja
    // y se reintenta una vez. El aviso de repetido va por HUELLA, que es lo que
    // de verdad distingue un archivo de otro.
    if (error) {
      await supabase.storage.from(BUCKET).remove([hacia]);
      ({ error } = await supabase.storage.from(BUCKET).move(desde, hacia));
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }

    await logAudit({
      user_email: user!.email ?? "unknown",
      action: "subir_archivo",
      filters: { ruta: hacia, fuente, nombre, huella, lote, tamano, desde },
    });

    return NextResponse.json({ ok: true, ruta: hacia });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el depósito." }, { status: 502 });
  }
}

/**
 * Borra del apartado un archivo que se soltó y no se va a subir.
 *
 * Es la ✕ de la tarjeta. El pipeline igual vacía `revision/` a los 2 días, pero
 * eso es la red: si la ✕ no borrara de verdad, el apartado crecería con cada
 * archivo que alguien suelta por error.
 */
export async function DELETE(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const ruta = typeof body?.ruta === "string" ? body.ruta.trim() : "";

  if (!rutaDeRevisionValida(ruta)) {
    return NextResponse.json(
      { error: "Solo se puede borrar un archivo que esté en el apartado de revisión." },
      { status: 400 }
    );
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase.storage.from(BUCKET).remove([ruta]);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }

    await logAudit({
      user_email: user!.email ?? "unknown",
      action: "descartar_archivo_soltado",
      filters: { ruta },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el depósito." }, { status: 502 });
  }
}
