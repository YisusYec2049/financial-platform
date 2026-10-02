import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { LIKE_PAGO_SIN_APLICAR } from "@/lib/pagoSinAplicar";
import { fetchCerradasManual } from "@/lib/cerradasManual";

// ¿A qué documentos se les ofrece el panel de asociar?
//
// Hasta el 2026-10-02 la respuesta era "a los que tienen 2+ INSCRIPCIONES distintas
// con cuota pendiente". Esa condición existía porque el panel preguntaba *"este
// pago, ¿a qué inscripción va?"* — una pregunta que solo tiene sentido con dos.
// Desde que el panel va por CUOTA la pregunta es la contraria (*"a esta cuota, ¿qué
// plata le entra?"*) y vale igual con una sola inscripción, así que la regla de las
// 2+ se cayó (decisión del usuario, §6 del spec).
//
// Lo que queda es: **el documento tiene alguna cuota abierta Y algún pago con plata
// sin repartir**. El segundo camino del 2026-08-21 —una cuota con el aviso
// `PAGO SIN APLICAR` cuenta como abierta aunque tenga `fecha_pago`— sigue vivo
// dentro del `.or()`; ya no necesita ser un camino aparte, porque sin la regla de
// las 2+ no hay nada que esquivar. La otra mitad del panel, los saldos a favor, no
// pasa por acá: la pantalla ya los tiene (`saldosPorDocumento`).
//
// 🔴 La cuenta del restante tiene que ser LA MISMA que la de GET /asociar, que es la
// que llena el panel. Hasta hoy esta ruta restaba solo `pago_asociaciones` y
// `pago_asociaciones_archivo`, sin el ledger de saldos y sin excluir los pagos
// sellados. Con 73 candidatos la diferencia casi no se notaba; sin la regla de las
// 2+ se vuelve el defecto principal: medido contra producción, la cuenta vieja
// ofrecería el botón en **876 documentos (1.049 filas)** y en **394 de ellos el
// panel abriría COMPLETAMENTE vacío** —toda la plata "libre" de esos pagos está
// sellada o ya comprometida en el ledger—. Con la cuenta alineada son **479
// documentos**, contra los 29 de la regla vieja.
//
// ⚠️ Los pagos APARTADOS (cesantías, matrícula, cheques, números de UC) se siguen
// ofreciendo, y es a propósito: se borran de `cruce_cartera` por diseño, así que no
// tienen fila de sello — y por el invariante 1.2 la AUSENCIA no es un sello.
// Tratarla como tal haría desaparecer del panel los apartados con cuota abierta del
// mismo documento. Hoy son 1.237 de los 2.090 pagos con restante.

const BATCH = 1000;

type Pagina<T> = { data: T[] | null; error: { message: string } | null };

// Recorre una tabla entera de a 1.000. 🔴 Nunca `.limit(N)` con N > 1.000 esperando
// N filas: PostgREST devuelve 1.000 como máximo y NO avisa (invariante 3.2), y acá
// una fila que no vuelve se lee como "este pago no tiene plata comprometida" o como
// "este documento no tiene pagos" — las dos en la dirección peligrosa.
async function recorrer<T>(
  pagina: (desde: number, hasta: number) => PromiseLike<Pagina<T>>,
): Promise<{ filas: T[]; error: string | null }> {
  const filas: T[] = [];
  for (let desde = 0; ; desde += BATCH) {
    const { data, error } = await pagina(desde, desde + BATCH - 1);
    if (error) return { filas, error: error.message };
    filas.push(...(data ?? []));
    if (!data || data.length < BATCH) break;
  }
  return { filas, error: null };
}

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();

  // Las seis lecturas son independientes, así que van en paralelo: secuenciales son
  // ~7 s y en paralelo ~3,5 s (medido). No es cosmético — esta ruta corre al montar
  // la vista y hasta que responde el botón "Asociar" no existe en ninguna fila.
  //
  // Las tres tablas de plata se recorren ENTERAS en vez de preguntar por lotes de
  // 200 `matching_key`: son ~5.200 filas (6 peticiones) contra 35 lotes × 3 tablas,
  // y de paso desaparece el riesgo del `.in()` largo que vuelve cortado sin error
  // (invariante 3.3).
  const [
    cerradasRes,
    cuotasRes,
    asociacionesRes,
    archivadasRes,
    saldosRes,
    selladosRes,
    pagosRes,
  ] = await Promise.all([
    fetchCerradasManual(supabase),

    // Las cuotas abiertas. ⚠️ El `.is("fecha_pago", null)` de siempre deja fuera
    // justamente las del aviso `PAGO SIN APLICAR`: una cuota corta SÍ tiene
    // fecha_pago (recibió el primer pago) y es el destino de esa asociación.
    // Sin ORDER BY, Postgres puede cambiar de reparto entre un lote y el siguiente
    // (invariante 3.1) y acá duele: una fila perdida es una persona a la que la
    // pantalla no le ofrece asociar su pago, sin decir por qué.
    recorrer<{ llave: string; cruce_access: string }>((desde, hasta) =>
      supabase
        .from("cartera_preventiva")
        .select("llave, cruce_access")
        .or(`fecha_pago.is.null,notificacion.like.${LIKE_PAGO_SIN_APLICAR}`)
        .not("cruce_access", "is", null)
        .neq("cruce_access", "")
        .order("id", { ascending: true })
        .range(desde, hasta)),

    recorrer<{ matching_key: string; monto: number }>((desde, hasta) =>
      supabase
        .from("pago_asociaciones")
        .select("matching_key, monto")
        .order("id", { ascending: true })
        .range(desde, hasta)),

    // Lo repartido bajo una cartera anterior cuenta igual: esa plata ya pagó una
    // cuota (invariante 1.1).
    recorrer<{ matching_key: string; monto: number }>((desde, hasta) =>
      supabase
        .from("pago_asociaciones_archivo")
        .select("matching_key, monto")
        .order("id", { ascending: true })
        .range(desde, hasta)),

    // El ledger: plata de un pago que ya está comprometida aunque no esté aplicada
    // a ninguna cuota. Sin este término un pago cuyo sobrante se volvió saldo a
    // favor se ofrece ENTERO y se cuenta dos veces (el caso `7780` del 12/08:
    // $800.000 aplicados desde un pago de $400.000).
    recorrer<{ matching_key: string | null; disponible: number }>((desde, hasta) =>
      supabase
        .from("cartera_saldos_favor")
        .select("matching_key, disponible")
        .eq("aplicado", false)
        .gt("disponible", 0)
        .order("id", { ascending: true })
        .range(desde, hasta)),

    // Los pagos sellados. Se piden las filas que TRAEN el sello (hoy 949) en vez de
    // usar `lib/sellados.ts`, que pregunta por lotes de 200 `matching_key`: acá
    // habría que preguntar por los ~7.000 del consolidado, o sea 35 peticiones para
    // la misma respuesta. El criterio es idéntico — y por el invariante 1.2 solo
    // cuenta la fila que existe y trae `aplicacion_cerrada_at`, nunca la ausencia.
    recorrer<{ matching_key: string }>((desde, hasta) =>
      supabase
        .from("cruce_cartera")
        .select("matching_key")
        .not("aplicacion_cerrada_at", "is", null)
        .order("matching_key", { ascending: true })
        .range(desde, hasta)),

    // 🔴 El consolidado se recorre entero (hoy 6.993 filas) y se cruza en JS. Lo que
    // NO se puede hacer es el `.in("identification", [...docs])` de antes: con la
    // regla de las 2+ eran 73 documentos y 175 pagos, y ahora son ~2.400 documentos
    // — esa petición devolvería 1.000 filas sin avisar y la mayoría de los
    // documentos se quedaría sin botón en silencio.
    recorrer<{ matching_key: string; identification: string | null; payment_amount: number }>((desde, hasta) =>
      supabase
        .from("consolidated_transactions")
        .select("matching_key, identification, payment_amount")
        .order("id", { ascending: true })
        .range(desde, hasta)),
  ]);

  const fallo = cerradasRes.error || cuotasRes.error || asociacionesRes.error
    || archivadasRes.error || saldosRes.error || selladosRes.error || pagosRes.error;
  if (fallo) return NextResponse.json({ error: fallo }, { status: 500 });

  // Una cuota cerrada a mano no cuenta como abierta (2026-10-02). El cierre vive en
  // `cartera_preventiva_overrides` y lo aplica el pipeline, así que durante el
  // reproceso la fila sigue con `fecha_pago` en NULL y el `.or()` de arriba la trae
  // como si estuviera abierta — el botón aparecería para un documento cuyas únicas
  // cuotas "abiertas" son, en realidad, cuotas que alguien acaba de cerrar, y el
  // panel abriría sin un solo destino válido (porque GET /asociar sí las excluye).
  const docsConCuotaAbierta = new Set<string>();
  for (const cuota of cuotasRes.filas) {
    if (cerradasRes.cerradas.has(cuota.llave)) continue;
    docsConCuotaAbierta.add(cuota.cruce_access);
  }
  if (docsConCuotaAbierta.size === 0) return NextResponse.json({ documentos: [] });

  const comprometido = new Map<string, number>();
  const sumar = (k: string, v: number) => comprometido.set(k, (comprometido.get(k) ?? 0) + Number(v));
  for (const a of asociacionesRes.filas) sumar(a.matching_key, a.monto);
  for (const a of archivadasRes.filas) sumar(a.matching_key, a.monto);
  for (const s of saldosRes.filas) if (s.matching_key) sumar(s.matching_key, s.disponible);

  const sellados = new Set(selladosRes.filas.map((r) => r.matching_key));

  const documentos = new Set<string>();
  for (const pago of pagosRes.filas) {
    const doc = pago.identification ?? "";
    if (!docsConCuotaAbierta.has(doc) || documentos.has(doc)) continue;
    if (sellados.has(pago.matching_key)) continue;
    if (Number(pago.payment_amount) - (comprometido.get(pago.matching_key) ?? 0) > 0) documentos.add(doc);
  }

  return NextResponse.json({ documentos: [...documentos] });
}
