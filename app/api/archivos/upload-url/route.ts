import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { BUCKET, esFuenteValida, rutaEntrada } from "@/lib/fuentes";

/**
 * Devuelve una URL firmada para que el NAVEGADOR suba el archivo directo al
 * depósito.
 *
 * 🔴 **Por acá viajan solo nombres y metadatos, nunca el archivo.** Vercel no
 * deja pasar cuerpos de más de ~4,5 MB, y los archivos de referencia del área
 * ya lo superan (`CARGUE PAGOS 2026 2.xlsx`, 5,9 MB). Subir a través de una
 * ruta de la app funciona en las pruebas con extractos chicos y **falla justo
 * con la cartera**, que es el archivo más importante del mes. No es un límite
 * configurable en este plan: si esto se "simplifica" mandando el archivo acá,
 * hay que rehacer la pantalla entera. Ver §2 de la spec.
 */
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const nombre = typeof body?.nombre === "string" ? body.nombre.trim() : "";
  const fuente = typeof body?.fuente === "string" ? body.fuente.trim() : "";
  const lote = typeof body?.lote === "string" && body.lote.trim() ? body.lote.trim() : null;

  if (!nombre) {
    return NextResponse.json({ error: "Falta el nombre del archivo." }, { status: 400 });
  }
  // La fuente se valida contra la lista cerrada: una fuente inventada crea una
  // carpeta que el pipeline no recorre, y el archivo se pierde en silencio.
  if (!esFuenteValida(fuente)) {
    return NextResponse.json({ error: `Fuente desconocida: ${fuente}` }, { status: 400 });
  }
  // El separador de lote es del pipeline (`split('__', 1)`): si viniera dentro
  // del identificador, el par de PayU dejaría de emparejarse.
  if (lote && lote.includes("__")) {
    return NextResponse.json({ error: "El lote no puede contener '__'." }, { status: 400 });
  }
  // `/` crearía una subcarpeta dentro de la fuente, que el pipeline no lista.
  if (nombre.includes("/")) {
    return NextResponse.json({ error: "El nombre del archivo no puede contener '/'." }, { status: 400 });
  }

  const ruta = rutaEntrada(fuente, nombre, lote);

  try {
    const supabase = createAdminClient();
    // `upsert` para que volver a subir un archivo con el mismo nombre lo
    // reemplace en vez de fallar. El aviso de repetido va por HUELLA (§5), que
    // es lo que de verdad distingue un archivo de otro.
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(ruta, { upsert: true });

    if (error || !data) {
      return NextResponse.json(
        { error: error?.message || "No se pudo preparar la subida." },
        { status: 502 }
      );
    }

    return NextResponse.json({ ruta, token: data.token, path: data.path, usuario: user!.email ?? "" });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el depósito." }, { status: 502 });
  }
}
