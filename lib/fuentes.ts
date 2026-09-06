/**
 * Las 13 fuentes del depósito, y cómo se arma la ruta de un archivo.
 *
 * 🔴 **Los valores son un contrato con el pipeline, no etiquetas de esta app.**
 * El nombre de la fuente ES la carpeta dentro del depósito
 * (`entrada/<fuente>/`), y `procesar_todos.py` la busca literalmente —
 * `FUENTES_DEL_DEPOSITO` en ese archivo tiene esta misma lista. Escribir uno
 * distinto no da error: el archivo se sube a una carpeta que nadie mira, y el
 * área queda creyendo que el pago entró. Lo que se cambia es `label`, **nunca**
 * `value`.
 *
 * Verificado el 2026-09-06 contra `procesar_todos.py`, `sync_cartera.py` y
 * `vigilante.py` del repo `matching-test`: los 13 coinciden uno a uno.
 */

/**
 * En qué parte de la pantalla vive la caja de esta fuente.
 *
 * - `cruce`  — "Archivos Cruce": los de referencia, contra los que se cruza
 *   todo lo demás. Van **primero**, que es el orden que ya sigue el vigilante.
 * - `bancos` — "Ingresos de bancos", ordenadas por uso real.
 */
export type GrupoFuente = "cruce" | "bancos";

export interface Fuente {
  /** El valor que viaja a la ruta del depósito. NO tocar sin cambiar el pipeline. */
  value: string;
  /** Lo que lee el área. El mismo nombre que ya usa en Drive. */
  label: string;
  grupo: GrupoFuente;
}

/**
 * ⚠️ El orden de este arreglo ES el orden de la pantalla.
 *
 * ⚠️ **Ninguna caja lleva un ejemplo de nombre de archivo debajo del título.**
 * El §3.2 de la spec lo pedía, y se quitó a pedido del usuario (2026-09-06, con
 * la pantalla a la vista): el nombre de la caja es lo único que hay que leer, y
 * el ejemplo competía con él. En los bancos además no identificaba nada — el
 * mismo origen llega con nombres dispares (`wompi.csv` y
 * `08-07-2026 08_07_transactions_.csv` son el mismo).
 */
export const FUENTES: Fuente[] = [
  // ── Archivos Cruce (referencia) ──
  { value: "payu_uc", label: "Payu UC", grupo: "cruce" },
  { value: "ingresos", label: "Ingresos PSE y PAYU", grupo: "cruce" },
  { value: "cartera_prev", label: "Cartera Preventiva", grupo: "cruce" },
  { value: "wompi_reporte", label: "Reporte Pagos WOMPI", grupo: "cruce" },

  // ── Ingresos de bancos, por uso real (4.301 pagos del consolidado) ──
  { value: "wompi", label: "WOMPI", grupo: "bancos" },
  { value: "placetopay", label: "PlaceToPay", grupo: "bancos" },
  { value: "bc2576", label: "Bancolombia 2576", grupo: "bancos" },
  { value: "stripe", label: "Stripe", grupo: "bancos" },
  { value: "bc2833", label: "Bancolombia 2833", grupo: "bancos" },
  { value: "payu", label: "PayU", grupo: "bancos" },
  { value: "payu_moneda", label: "PayU moneda", grupo: "bancos" },

  // ⚠️ **0 pagos en toda la historia**, de 4.301: los parsers existen y las
  // carpetas están configuradas, pero nunca ha entrado un archivo por acá. Van
  // últimas por eso.
  //
  // El §2.3 de la spec las quería plegadas detrás de un "Ver más fuentes", con
  // el argumento de que dos cajas permanentemente vacías le enseñan al área a
  // ignorar las cajas vacías. **El usuario pidió verlas con las demás**
  // (2026-09-06, mirando la pantalla), así que el plegado se quitó.
  { value: "colpatria", label: "Colpatria", grupo: "bancos" },
  { value: "davivienda", label: "Davivienda", grupo: "bancos" },
];

export const FUENTES_CRUCE = FUENTES.filter((f) => f.grupo === "cruce");
export const FUENTES_BANCOS = FUENTES.filter((f) => f.grupo === "bancos");

export const VALORES_FUENTE = FUENTES.map((f) => f.value);

export const ETIQUETA_FUENTE: Record<string, string> = Object.fromEntries(
  FUENTES.map((f) => [f.value, f.label])
);

export function esFuenteValida(v: string): boolean {
  return VALORES_FUENTE.includes(v);
}

/** El bucket lo crea el pipeline; acá solo se nombra. */
export const BUCKET = "archivos-pipeline";
export const ENTRADA = "entrada";

/** Las dos fuentes que se suben en par. Ver §4 de la spec original. */
export const PAYU_PAR: [string, string] = ["payu", "payu_moneda"];

/**
 * El único aviso de fuente equivocada que vale la pena.
 *
 * Los archivos de Bancolombia traen **el número de cuenta en el nombre**
 * (`ZIP_16869342576_…` → 2576, `ZIP_19100002833_…` → 2833) y esa es la única
 * señal inequívoca que existe. Hoy soltarlo en la caja equivocada es un error
 * **silencioso**: el archivo se procesa con el módulo del banco que no es.
 *
 * 🔴 **Del resto no se avisa nada, a propósito.** La misma fuente llega con
 * nombres completamente distintos —Stripe entra como `unified_payments (43).csv`
 * y como `stripe.csv`—, así que cualquier otra advertencia sería falsa la mitad
 * de las veces y el área aprendería a ignorarlas, incluida esta.
 *
 * Devuelve el texto del aviso, o `null` si no hay nada que decir.
 */
export function avisoDeCuenta(nombre: string, fuente: string): string | null {
  const CUENTAS: Record<string, string> = { bc2576: "2576", bc2833: "2833" };
  const propia = CUENTAS[fuente];
  if (!propia) return null;

  const otra = propia === "2576" ? "2833" : "2576";
  // La condición pide la otra cuenta Y que no aparezca la propia: si el nombre
  // trae las dos, no hay nada seguro que decir y callarse es lo correcto.
  if (nombre.includes(otra) && !nombre.includes(propia)) {
    return `Este archivo parece de Bancolombia ${otra}. ¿Seguro que va acá?`;
  }
  return null;
}

/**
 * Identificador de lote para el par de PayU.
 *
 * 🔴 **Sin `__` adentro**: `procesar_todos.py:_lote_de()` hace
 * `nombre.split('__', 1)[0]`, así que un `__` en el propio identificador
 * partiría el lote por la mitad y los dos archivos dejarían de emparejarse.
 * Solo letras y números, por eso base36.
 */
export function nuevoLote(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `L${t}${r}`;
}

/**
 * La ruta destino dentro del bucket.
 *
 * El lote va como prefijo del NOMBRE, no como carpeta: el pipeline lista
 * `entrada/<fuente>/` y lee el lote del nombre del archivo.
 */
export function rutaEntrada(fuente: string, nombre: string, lote?: string | null): string {
  const base = lote ? `${lote}__${nombre}` : nombre;
  return `${ENTRADA}/${fuente}/${base}`;
}

/** El nombre real, sin el prefijo de lote, para mostrarlo en pantalla. */
export function nombreSinLote(nombre: string): string {
  const i = nombre.indexOf("__");
  return i === -1 ? nombre : nombre.slice(i + 2);
}

/** El lote de un nombre ya subido, o "" — misma regla que `_lote_de()` del pipeline. */
export function loteDeNombre(nombre: string): string {
  const i = nombre.indexOf("__");
  return i === -1 ? "" : nombre.slice(0, i).trim();
}
