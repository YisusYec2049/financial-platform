import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

// Historial de correcciones de documento, de solo lectura (spec "Sugerir las
// correcciones de documento que ya se hicieron antes").
//
// Alimenta dos avisos en las vistas que corrigen documento:
//   A) este pago ya se corrigió antes  -> correcciones con matching_key_original = el del pago
//   B) este número se corrigió en otro pago -> correcciones con documento_original = el de la fila
//
// Nunca aplica nada: el cambio lo hace la persona con el ✓ de siempre. Reemplaza
// la memoria automática que el pipeline dejó de tener el 5 de agosto (una
// corrección aplicada "por número" le pisó el documento al pago de otra persona).
//
// UNA consulta por lista para toda la página, no una por fila: son 100 filas por
// página y una consulta por fila serían 100 viajes a la base en cada paso de página.
//
// No se usa .or(...) con .in.(...) interpolado a mano a propósito: los valores
// entrarían crudos en el lenguaje de filtros de PostgREST y las matching_key
// llevan paréntesis ("…(duplicado)") y barras. Dos .in() separados dejan que
// postgrest-js entrecomille cada valor, que es lo que evita la clase de rotura
// que ya mordió en lib/search.ts.

type Correccion = {
  documento_original: string;
  documento_corregido: string;
  matching_key_original: string | null;
  fecha_correccion: string | null;
  created_at: string;
};

// Lotes chicos: una lista larga dentro de un .in() vuelve cortada sin error.
const CHUNK = 100;
const BATCH = 1000;

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const v of raw.split(",")) {
    const clean = v.trim().slice(0, 120);
    if (clean) seen.add(clean);
  }
  // Tope defensivo: la página son 100 filas, así que 500 valores ya es señal de
  // que alguien está llamando la ruta a mano.
  return [...seen].slice(0, 500);
}

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const documentos = parseList(req.nextUrl.searchParams.get("documentos"));
  const pagos      = parseList(req.nextUrl.searchParams.get("pagos"));

  if (documentos.length === 0 && pagos.length === 0) {
    return NextResponse.json({ correcciones: [] });
  }

  const supabase = createAdminClient();
  const porLlave = new Map<string, Correccion>();

  const traer = async (columna: "documento_original" | "matching_key_original", valores: string[]) => {
    for (let i = 0; i < valores.length; i += CHUNK) {
      const lote = valores.slice(i, i + CHUNK);
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("documento_correcciones")
          .select("documento_original, documento_corregido, matching_key_original, fecha_correccion, created_at")
          .in(columna, lote)
          .order("created_at", { ascending: false })
          // Desempate obligatorio: sin columna única al final del orden, el corte
          // entre lotes pierde filas en silencio. documento_correcciones NO tiene
          // `id` (su PK es documento_original); se agrega matching_key_original
          // para que el orden siga siendo único si algún día se le quita esa PK.
          .order("documento_original", { ascending: true })
          .order("matching_key_original", { ascending: true })
          .range(from, from + BATCH - 1);

        if (error) return error.message;
        if (!data || data.length === 0) break;

        for (const c of data as Correccion[]) {
          // Las dos consultas se solapan (una corrección puede caer en ambas);
          // se deduplica por su contenido, que es lo único identificable —
          // la tabla no expone una clave sintética.
          porLlave.set(
            `${c.matching_key_original ?? ""}|${c.documento_original}|${c.documento_corregido}|${c.created_at}`,
            c,
          );
        }

        if (data.length < BATCH) break;
        from += BATCH;
      }
    }
    return null;
  };

  const errDoc = documentos.length ? await traer("documento_original", documentos) : null;
  if (errDoc) return NextResponse.json({ error: errDoc }, { status: 500 });

  const errPago = pagos.length ? await traer("matching_key_original", pagos) : null;
  if (errPago) return NextResponse.json({ error: errPago }, { status: 500 });

  const correcciones = [...porLlave.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return NextResponse.json({ correcciones });
}
