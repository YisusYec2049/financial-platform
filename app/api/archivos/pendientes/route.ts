import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/server";
import { BUCKET, ENTRADA, FUENTES, esFuenteValida, loteDeNombre, nombreSinLote } from "@/lib/fuentes";

/** Supabase deja este objeto para que una "carpeta" vacía exista. No es un archivo del área. */
const PLACEHOLDER = ".emptyFolderPlaceholder";
/** El listado del Storage devuelve como máximo 100 por página. */
const POR_PAGINA = 100;

export interface ArchivoPendiente {
  ruta: string;
  fuente: string;
  /** El nombre real, ya sin el prefijo de lote. */
  nombre: string;
  lote: string;
  tamano: number | null;
  subido_at: string | null;
  subido_por: string | null;
}

/**
 * Lista lo que hay en la entrada del depósito, o sea lo que el pipeline va a
 * procesar en la próxima corrida.
 *
 * ⚠️ **La verdad es el depósito, no una tabla.** Se lee lo mismo que lee
 * `utils/deposito.py:listar()`, así que lo que se ve acá es exactamente lo que
 * el pipeline va a tomar. Una lista propia se desincronizaría en cuanto el
 * pipeline archive algo.
 */
async function listarFuente(
  supabase: ReturnType<typeof createAdminClient>,
  fuente: string
): Promise<ArchivoPendiente[]> {
  const encontrados: ArchivoPendiente[] = [];
  let offset = 0;

  // Se pagina por el mismo motivo que el pipeline: sin paginar, los que se
  // pierden son los ÚLTIMOS, o sea los más nuevos — justo los del día.
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(`${ENTRADA}/${fuente}`, {
      limit: POR_PAGINA,
      offset,
      sortBy: { column: "created_at", order: "asc" },
    });

    if (error) throw new Error(`${fuente}: ${error.message}`);
    const pagina = data ?? [];

    for (const obj of pagina) {
      // Sin `id` es una carpeta, no un archivo.
      if (!obj.id || !obj.name || obj.name === PLACEHOLDER) continue;
      encontrados.push({
        ruta: `${ENTRADA}/${fuente}/${obj.name}`,
        fuente,
        nombre: nombreSinLote(obj.name),
        lote: loteDeNombre(obj.name),
        tamano: (obj.metadata?.size as number | undefined) ?? null,
        subido_at: obj.created_at ?? null,
        subido_por: null,
      });
    }

    if (pagina.length < POR_PAGINA) return encontrados;
    offset += POR_PAGINA;
  }
}

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  try {
    const supabase = createAdminClient();

    const listas = await Promise.all(FUENTES.map((f) => listarFuente(supabase, f.value)));
    const archivos = listas.flat();

    // "Quién lo subió" sale de `audit_logs`, no del depósito: el Storage no
    // guarda metadatos propios del objeto (probado el 2026-09-06) y el pipeline
    // no puede llenar `subido_por`. Ver el comentario de `registrar/route.ts`.
    if (archivos.length) {
      const { data: subidas } = await supabase
        .from("audit_logs")
        .select("user_email, created_at, filters")
        .eq("action", "subir_archivo")
        .order("created_at", { ascending: false })
        .limit(500);

      const porRuta = new Map<string, string>();
      for (const fila of subidas ?? []) {
        const ruta = (fila.filters as { ruta?: string } | null)?.ruta;
        // El primero que aparece es el más reciente (orden descendente).
        if (ruta && !porRuta.has(ruta)) porRuta.set(ruta, fila.user_email);
      }
      for (const a of archivos) a.subido_por = porRuta.get(a.ruta) ?? null;
    }

    // Del más nuevo al más viejo: lo que se acaba de subir es lo que se mira.
    archivos.sort((a, b) => (b.subido_at ?? "").localeCompare(a.subido_at ?? ""));

    return NextResponse.json({ archivos });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "No se pudo leer el depósito." },
      { status: 502 }
    );
  }
}

/**
 * Quita un archivo de la entrada ANTES de procesarlo. Es la salida cuando
 * alguien se equivocó de fuente.
 *
 * ⚠️ Solo alcanza a `entrada/`. Deshacer algo ya procesado es otra cosa —habría
 * que borrar pagos del consolidado— y no está diseñado (§11.2 de la spec).
 */
export async function DELETE(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const ruta = typeof body?.ruta === "string" ? body.ruta.trim() : "";

  const partes = ruta.split("/");
  if (partes.length !== 3 || partes[0] !== ENTRADA || !esFuenteValida(partes[1]) || !partes[2]) {
    return NextResponse.json(
      { error: "Solo se puede quitar un archivo que esté en la entrada, sin procesar." },
      { status: 400 }
    );
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase.storage.from(BUCKET).remove([ruta]);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }

    logAudit({
      user_email: user!.email ?? "unknown",
      action: "quitar_archivo",
      filters: { ruta },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el depósito." }, { status: 502 });
  }
}
