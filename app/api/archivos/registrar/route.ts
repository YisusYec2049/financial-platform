import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { esFuenteValida } from "@/lib/fuentes";

/**
 * Deja constancia de que alguien subió un archivo. Se llama DESPUÉS de que el
 * navegador terminó de subirlo al depósito.
 *
 * 🔴 **No escribe en `archivos_procesados`, y eso es deliberado.** Esa tabla la
 * llena el pipeline: `utils/registro.py:anotar()` hace un INSERT por archivo
 * PROCESADO, no un update de una fila que la app hubiera dejado. Si esta app
 * insertara al subir, cada archivo tendría dos filas y —peor— el aviso de
 * repetido (§5) saltaría con archivos que solo se subieron, diciendo "ya se
 * procesó y dejó N pagos" cuando no se procesó nada.
 *
 * Por eso "quién lo subió" vive en `audit_logs`, que esta app ya escribe para
 * todo lo demás. `subido_por` / `subido_at` de `archivos_procesados` quedan en
 * NULL: comprobado que el pipeline no puede llenarlas — `utils/deposito.py`
 * lista el depósito y devuelve solo `{id, name}`, y el Storage de Supabase no
 * guarda metadatos propios del objeto (probado el 2026-09-06).
 */
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const ruta = typeof body?.ruta === "string" ? body.ruta.trim() : "";
  const fuente = typeof body?.fuente === "string" ? body.fuente.trim() : "";
  const nombre = typeof body?.nombre === "string" ? body.nombre.trim() : "";
  const huella = typeof body?.huella === "string" ? body.huella.trim() : "";
  const lote = typeof body?.lote === "string" && body.lote.trim() ? body.lote.trim() : null;
  const tamano = typeof body?.tamano === "number" ? body.tamano : null;

  if (!ruta || !esFuenteValida(fuente)) {
    return NextResponse.json({ error: "Datos de la subida incompletos." }, { status: 400 });
  }

  await logAudit({
    user_email: user!.email ?? "unknown",
    action: "subir_archivo",
    filters: { ruta, fuente, nombre, huella, lote, tamano },
  });

  return NextResponse.json({ ok: true });
}
