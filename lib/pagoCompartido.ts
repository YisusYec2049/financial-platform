import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * "Pago compartido": un pago cuya plata terminó pagando cuotas de MÁS DE UNA
 * persona. Pasa desde el traslado de saldo (19 de agosto) — un diplomado de dos
 * cupos pagado de un solo giro, una empresa por su empleado, un familiar por otro.
 *
 * En `cruce_cartera` eso sigue siendo UNA fila, con el documento del pagador y el
 * monto entero: quien revisa ve $1.336.400 a nombre de Guillermo sin forma de saber
 * que la mitad pagó la cuota de otra persona, y buscando por el documento de la otra
 * no encuentra nada. Acá se calcula cómo se reparte esa plata **por persona**, para
 * mostrarla como dos renglones.
 *
 * ⚠️ **Es presentación, no dato.** No se escriben dos filas en `cruce_cartera` (su
 * PK es el `matching_key`, y el cuadre, el sello y el reparto cuentan POR PAGO), no
 * se toca ninguna columna y no se suma el pago dos veces en ningún total.
 */

/** Igual que el pipeline (`utils/parser.normalizar_nit`) y que las funciones de
 *  traslado: quita el dígito de verificación de un NIT y NADA más. Normalizar
 *  distinto que allá es el bug del 4 de agosto — acá haría que una empresa se viera
 *  partida en dos por su propio DV. */
export const normalizarDocumento = (d: string | null | undefined): string =>
  (d ?? "").trim().replace(/-\d$/, "");

export type Renglon = {
  documento: string;
  titular: string | null;
  incp: string | null;
  monto: number;
  /** El renglón del pagador (el documento que trae el pago). Es el único que
   *  corresponde de verdad a la fila de `cruce_cartera`, así que es el único que
   *  se puede editar. */
  principal: boolean;
};

type PagoBase = {
  matching_key: string;
  identification: string | null;
  payment_amount: number | null;
};

const LOTE = 200;
const TOLERANCIA = 0.01;

/**
 * A partir de cuántas llaves sale más barato leer la tabla entera que preguntar por
 * lotes. `pago_asociaciones` (~1.200 filas) y `cartera_saldos_favor` (~114) son
 * chicas; pedirlas en lotes de 200 para una descarga de 2.300 pagos son 24 viajes,
 * medidos en ~6 s. Leerlas enteras son 3. El corte no cambia NINGÚN resultado, solo
 * el camino: lo que se filtra después es idéntico.
 */
const BARRIDO_DESDE = 400;

/** Lee una tabla entera por páginas. El `order` por la PK no es decorativo: sin una
 *  columna única al final del orden, el corte entre páginas pierde filas en silencio
 *  (regla del 5 de agosto) — y acá una fila perdida es plata de una persona que
 *  desaparece de la pantalla. */
async function leerTodo<T>(
  pagina: (desde: number, hasta: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<{ filas: T[]; error: string | null }> {
  const filas: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await pagina(from, from + 999);
    if (error) return { filas, error: error.message };
    filas.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return { filas, error: null };
}

/**
 * Devuelve `Map<matching_key, Renglon[]>` **solo para los pagos que se dividen**
 * (los que tocan 2+ documentos). Un pago normal no aparece en el mapa.
 *
 * La regla (§3 del spec): se mira `pago_asociaciones` **viva** → `llave` →
 * `cartera_preventiva`, de donde salen el documento, el nombre y el INCP de cada
 * renglón. Las **archivadas no cuentan**: un pago que repartió plata bajo la
 * cartera anterior no es un pago compartido de hoy.
 *
 * El monto de cada renglón es **lo aplicado a las cuotas de esa persona + lo que le
 * queda disponible en el ledger**. Sumar el disponible es lo que hace que los
 * renglones sumen lo que entró aunque el reparto esté a medias, y es la misma cuenta
 * del chequeo de cuadre del pipeline (`entró = aplicado + disponible`).
 */
export async function fetchRenglonesCompartidos(
  supabase: Admin,
  pagos: PagoBase[],
): Promise<{ renglones: Map<string, Renglon[]>; error: string | null }> {
  const renglones = new Map<string, Renglon[]>();
  const claves = [...new Set(pagos.map((p) => p.matching_key).filter(Boolean))];
  if (claves.length === 0) return { renglones, error: null };

  const clavesSet = new Set(claves);
  const barrido = claves.length >= BARRIDO_DESDE;

  // 1. Las asociaciones VIVAS de esos pagos. Por lotes y con `.in()`, como en
  //    lib/sellados.ts: un `.in()` largo puede volver cortado sin error, y acá un
  //    lote cortado haría desaparecer un renglón (o sea, plata de una persona).
  type Asoc = { matching_key: string; llave: string; monto: number };
  const asociaciones: Asoc[] = [];
  const agregarAsoc = (a: Record<string, unknown>) => {
    if (!clavesSet.has(a.matching_key as string)) return;
    asociaciones.push({ matching_key: a.matching_key as string, llave: a.llave as string, monto: Number(a.monto) });
  };
  const cargarAsociaciones = async (): Promise<string | null> => {
    if (barrido) {
      const { filas, error } = await leerTodo<Record<string, unknown>>((desde, hasta) =>
        supabase
          .from("pago_asociaciones")
          .select("matching_key, llave, monto")
          .order("id", { ascending: true })
          .range(desde, hasta));
      if (error) return error;
      filas.forEach(agregarAsoc);
      return null;
    }
    for (let i = 0; i < claves.length; i += LOTE) {
      const { data, error } = await supabase
        .from("pago_asociaciones")
        .select("matching_key, llave, monto")
        .in("matching_key", claves.slice(i, i + LOTE));
      if (error) return error.message;
      (data ?? []).forEach(agregarAsoc);
    }
    return null;
  };

  // 2. Lo que todavía no se aplicó pero ya tiene dueño: el ledger de saldos a favor.
  //    Una fila `origen='traslado'` es plata que ya es de la otra persona aunque
  //    nadie la haya asociado.
  type Saldo = { matching_key: string; documento: string; cliente: string | null; disponible: number };
  const saldos: Saldo[] = [];
  const agregarSaldo = (s: Record<string, unknown>) => {
    if (!clavesSet.has(s.matching_key as string)) return;
    saldos.push({
      matching_key: s.matching_key as string,
      documento: normalizarDocumento(s.documento as string),
      cliente: (s.cliente as string) ?? null,
      disponible: Number(s.disponible),
    });
  };
  const cargarSaldos = async (): Promise<string | null> => {
    if (barrido) {
      const { filas, error } = await leerTodo<Record<string, unknown>>((desde, hasta) =>
        supabase
          .from("cartera_saldos_favor")
          .select("matching_key, documento, cliente, disponible")
          .eq("aplicado", false)
          .gt("disponible", 0)
          .order("id", { ascending: true })
          .range(desde, hasta));
      if (error) return error;
      filas.forEach(agregarSaldo);
      return null;
    }
    for (let i = 0; i < claves.length; i += LOTE) {
      const { data, error } = await supabase
        .from("cartera_saldos_favor")
        .select("matching_key, documento, cliente, disponible")
        .in("matching_key", claves.slice(i, i + LOTE))
        .eq("aplicado", false)
        .gt("disponible", 0);
      if (error) return error.message;
      (data ?? []).forEach(agregarSaldo);
    }
    return null;
  };

  // Las dos lecturas son independientes: en serie, cada página del cruce pagaría dos
  // viajes a la base antes de pintar nada.
  const [errorAsoc, errorSaldos] = await Promise.all([cargarAsociaciones(), cargarSaldos()]);
  if (errorAsoc)   return { renglones, error: errorAsoc };
  if (errorSaldos) return { renglones, error: errorSaldos };

  // 3. De qué persona es cada cuota. El nombre y el INCP salen de acá y de ningún
  //    otro lado: si una llave no tiene fila en cartera, no hay renglón que inventar.
  //
  //    Solo se preguntan las cuotas de los pagos que PODRÍAN dividirse: con UNA sola
  //    asociación hay un solo documento, y el ledger no divide (solo suma montos a un
  //    pago ya dividido), así que no hay nada que resolver. En una descarga entera eso
  //    baja las cuotas a consultar de ~1.200 a ~20, y en una página normal la deja
  //    en cero.
  const asocPorPago = new Map<string, number>();
  for (const a of asociaciones) asocPorPago.set(a.matching_key, (asocPorPago.get(a.matching_key) ?? 0) + 1);
  const candidatos = new Set(
    [...asocPorPago.entries()].filter(([, n]) => n > 1).map(([mk]) => mk),
  );

  const llaves = [...new Set(asociaciones.filter((a) => candidatos.has(a.matching_key)).map((a) => a.llave))];
  const cuota = new Map<string, { documento: string; cliente: string | null; inscrip: string | null }>();
  for (let i = 0; i < llaves.length; i += LOTE) {
    const { data, error } = await supabase
      .from("cartera_preventiva")
      .select("llave, cruce_access, cliente, inscrip")
      .in("llave", llaves.slice(i, i + LOTE));
    if (error) return { renglones, error: error.message };
    for (const c of data ?? []) {
      cuota.set(c.llave as string, {
        documento: normalizarDocumento(c.cruce_access as string),
        cliente: (c.cliente as string) ?? null,
        inscrip: (c.inscrip as string) ?? null,
      });
    }
  }

  // 4. Se arma el reparto por pago y por documento.
  type Acum = { documento: string; titular: string | null; incp: string | null; monto: number };
  const porPago = new Map<string, Map<string, Acum>>();
  const sumaViva = new Map<string, number>();

  const acumular = (mk: string, doc: string, monto: number, titular: string | null, incp: string | null) => {
    if (!doc) return;
    let docs = porPago.get(mk);
    if (!docs) { docs = new Map(); porPago.set(mk, docs); }
    const actual = docs.get(doc) ?? { documento: doc, titular: null, incp: null, monto: 0 };
    actual.monto += monto;
    actual.titular ??= titular;
    actual.incp    ??= incp;
    docs.set(doc, actual);
  };

  // Los documentos que tocan las asociaciones VIVAS, que son los que deciden si el
  // pago se divide. Se lleva aparte del acumulado porque el ledger suma montos pero
  // NO decide: mientras el saldo siga esperando en la pantalla de la otra persona, el
  // pago se sigue viendo entero (§3).
  const docsAsociados = new Map<string, Set<string>>();

  for (const a of asociaciones) {
    const c = cuota.get(a.llave);
    sumaViva.set(a.matching_key, (sumaViva.get(a.matching_key) ?? 0) + a.monto);
    if (!c) continue; // sin cuota no hay renglón (§7)
    acumular(a.matching_key, c.documento, a.monto, c.cliente, c.inscrip);
    if (c.documento) {
      const set = docsAsociados.get(a.matching_key) ?? new Set<string>();
      set.add(c.documento);
      docsAsociados.set(a.matching_key, set);
    }
  }
  for (const s of saldos) {
    acumular(s.matching_key, s.documento, s.disponible, s.cliente, null);
  }

  // 5. Se dividen SOLO los pagos cuyas asociaciones vivas tocan 2+ documentos. Una
  //    vez dividido, un documento que solo aparezca en el ledger SÍ suma su renglón:
  //    si no, los renglones no sumarían lo que entró.
  const divididos = [...porPago.entries()].filter(([mk]) => (docsAsociados.get(mk)?.size ?? 0) > 1);
  if (divididos.length === 0) return { renglones, error: null };

  // 6. Lo repartido bajo una cartera anterior. NO divide (§7) pero sí hay que
  //    restarlo para saber qué le queda libre al pagador — si no, ese sobrante se
  //    contaría dos veces y los renglones sumarían más de lo que entró.
  const clavesDivididas = divididos.map(([mk]) => mk);
  const archivado = new Map<string, number>();
  for (let i = 0; i < clavesDivididas.length; i += LOTE) {
    const { data, error } = await supabase
      .from("pago_asociaciones_archivo")
      .select("matching_key, monto")
      .in("matching_key", clavesDivididas.slice(i, i + LOTE));
    if (error) return { renglones, error: error.message };
    for (const a of data ?? []) {
      archivado.set(a.matching_key as string, (archivado.get(a.matching_key as string) ?? 0) + Number(a.monto));
    }
  }

  const pagoPorClave = new Map(pagos.map((p) => [p.matching_key, p]));

  for (const [mk, docs] of divididos) {
    const pago = pagoPorClave.get(mk);
    const docPagador = normalizarDocumento(pago?.identification);
    const entro = Number(pago?.payment_amount ?? 0);

    // Lo que el pago todavía no repartió sigue siendo del pagador. Sin esto los
    // renglones no suman `payment_amount`, que es la comprobación obligatoria del
    // §3 — y en la descarga la columna del monto no daría el total real.
    // Es la misma fórmula de cuatro términos del panel de asociar (`restante`).
    const disponibleLedger = saldos
      .filter((s) => s.matching_key === mk)
      .reduce((a, s) => a + s.disponible, 0);
    const sobrante = entro - (sumaViva.get(mk) ?? 0) - (archivado.get(mk) ?? 0) - disponibleLedger;
    if (sobrante > TOLERANCIA && docPagador) {
      const actual = docs.get(docPagador) ?? { documento: docPagador, titular: null, incp: null, monto: 0 };
      actual.monto += sobrante;
      docs.set(docPagador, actual);
    }

    const lista: Renglon[] = [...docs.values()]
      .map((d) => ({ ...d, principal: d.documento === docPagador }))
      // El pagador primero, el resto por documento: un orden estable es lo que
      // evita que la misma página se vea distinta en dos recargas.
      .sort((a, b) => Number(b.principal) - Number(a.principal) || a.documento.localeCompare(b.documento));

    renglones.set(mk, lista);
  }

  return { renglones, error: null };
}

/** Una fila de la tabla ya expandida: puede haber varias por `matching_key`. */
export type FilaExpandida = Record<string, unknown> & {
  matching_key: string;
  renglon_id: string;
  compartido: boolean;
  titular: string | null;
  principal: boolean;
};

/**
 * Convierte las filas del cruce en renglones. Un pago normal sale tal cual (un
 * renglón, `compartido: false`); uno compartido sale una vez por persona, con el
 * documento, el INCP y el monto de cada una — las demás columnas **no cambian entre
 * renglones**, porque es el mismo pago y eso es justo lo que comunica la etiqueta.
 */
export function expandirRenglones(
  rows: Record<string, unknown>[],
  renglones: Map<string, Renglon[]>,
): FilaExpandida[] {
  return rows.flatMap((row): FilaExpandida[] => {
    const mk = row.matching_key as string;
    const lista = renglones.get(mk);
    if (!lista) {
      return [{ ...row, matching_key: mk, renglon_id: mk, compartido: false, titular: null, principal: true }];
    }
    return lista.map((r, i) => ({
      ...row,
      matching_key: mk,
      identification: r.documento,
      payment_amount: r.monto,
      // En el renglón del pagador se conserva el INCP GUARDADO, que es el que se
      // edita y el que el pipeline lee; en los demás va el de la inscripción que
      // esa persona pagó, y son de solo lectura.
      incp: r.principal ? row.incp : r.incp,
      renglon_id: `${mk}#${i}`,
      compartido: true,
      titular: r.titular,
      principal: r.principal,
    }));
  });
}

/**
 * Los `matching_key` que hay que traer ADEMÁS de los que encuentra el buscador por
 * las columnas del propio pago: los de la segunda persona de un pago compartido.
 * Hoy buscar por su documento no encuentra nada, porque `cruce_cartera.identification`
 * es el del pagador y nada más — y ese es el uso principal de esta entrega: el área
 * llega por ahí, no por el pagador.
 *
 * Se busca por documento y por INCP de la cuota, y por documento en el ledger.
 */
export async function matchingKeysPorPersona(
  supabase: Admin,
  search: string,
): Promise<{ keys: string[]; error: string | null }> {
  const keys = new Set<string>();
  if (!search) return { keys: [], error: null };

  const { data: cuotas, error: cuotasError } = await supabase
    .from("cartera_preventiva")
    .select("llave")
    .or(`cruce_access.ilike.%${search}%,inscrip.ilike.%${search}%`)
    // Tope defensivo: una búsqueda de un solo carácter engancharía miles de cuotas.
    // Pasado ese punto la búsqueda normal ya devuelve de todo, así que recortar acá
    // no esconde nada que el usuario estuviera buscando de verdad.
    .order("id", { ascending: true })
    .limit(1000);
  if (cuotasError) return { keys: [], error: cuotasError.message };

  const llaves = (cuotas ?? []).map((c) => c.llave as string);
  for (let i = 0; i < llaves.length; i += LOTE) {
    const { data, error } = await supabase
      .from("pago_asociaciones")
      .select("matching_key")
      .in("llave", llaves.slice(i, i + LOTE));
    if (error) return { keys: [], error: error.message };
    for (const a of data ?? []) keys.add(a.matching_key as string);
  }

  const { data: saldos, error: saldosError } = await supabase
    .from("cartera_saldos_favor")
    .select("matching_key")
    .ilike("documento", `%${search}%`)
    .order("id", { ascending: true })
    .limit(1000);
  if (saldosError) return { keys: [], error: saldosError.message };
  for (const s of saldos ?? []) {
    if (s.matching_key) keys.add(s.matching_key as string);
  }

  return { keys: [...keys], error: null };
}

/**
 * El fragmento `matching_key.in.(...)` para meter esas llaves dentro del `.or()` del
 * buscador.
 *
 * ⚠️ **Las llaves van entre comillas dobles.** Dentro de un `.or()` los valores
 * entran CRUDOS en el lenguaje de filtros de PostgREST, y las llaves de Bancolombia
 * llevan barras, comas y paréntesis (`16/07/2026_816002330_2457251 (duplicado)`).
 * Sin comillas la consulta no falla: **devuelve vacío en silencio** (comprobado), que
 * es la peor forma de romperse. Es la misma trampa que `_` en `lib/search.ts`.
 */
export function orMatchingKeys(keys: string[], tope = 300): string {
  if (keys.length === 0) return "";
  const lista = keys
    .slice(0, tope)
    .map((k) => `"${k.replace(/"/g, "")}"`)
    .join(",");
  return `matching_key.in.(${lista})`;
}
