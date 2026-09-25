import { sanitizeSearch } from "@/lib/search";

/**
 * Los filtros del Histórico de Carteras, en UN solo sitio.
 *
 * 🔴 La lista y la descarga tienen que leer exactamente lo mismo. Copiar la cláusula en
 * las dos rutas es justo lo que se desincroniza: el 3 de agosto "Cerrar Cartera"
 * ignoraba el filtro de Día del Cruce y cerraba lo de hoy, y el 19 "Le falta plata"
 * alcanzaba 218 cuotas en vez de 15. Acá no hay pantalla que escriba nada (la sección es
 * de solo lectura), pero el Excel es el entregable del área y tiene que traer lo que la
 * pantalla dice que trae.
 */

/**
 * La vista que une la cartera viva y el archivo (`sql/025` de matching-test). Agrega
 * cuatro columnas sobre las 28 de la cartera: `carga_id` (el literal `viva` en la tabla
 * de trabajo), `fecha_archivo`, `fecha_referencia` = coalesce(fecha_cruce, fecha_pago) y
 * `cruce_externo` = (fecha_cruce is null).
 *
 * ⚠️ Cuando el pipeline le agregue una columna a `cartera_preventiva` hay que recrear la
 * vista: con `create or replace` no alcanza si cambia el número de columnas, y al
 * recrearla hay que repetir el `alter view ... set (security_invoker = on)` — sin eso la
 * vista corre con los permisos de quien la creó y se salta el RLS de sus tablas base.
 */
export const VISTA_HISTORICO = "cartera_historico_todo_v";

/** La cartera viva no tiene `carga_id` propio — solo el archivo lo tiene. En la vista se
 *  identifica con este literal, y NO se le inventa uno. La pantalla lo usa para etiquetar
 *  de qué carga viene cada fila. */
export const CARTERA_VIVA = "viva";

export type FiltrosHistorico = {
  search: string;
  estado: string;
  cruceFrom: string;
  cruceTo: string;
  incluirExterno: boolean;
};

export function parseFiltrosHistorico(sp: URLSearchParams): FiltrosHistorico {
  return {
    search:         sanitizeSearch(sp.get("search")),
    estado:         sp.get("estado") || "todas",
    cruceFrom:      sp.get("cruce_from") || "",
    cruceTo:        sp.get("cruce_to") || "",
    incluirExterno: sp.get("externo") === "1",
  };
}

// Tipo estructural: los métodos del builder de supabase-js devuelven `this`, así que
// esto calza con la consulta real sin arrastrar sus genéricos (que al encadenar
// filtros condicionales hacen explotar la inferencia, TS2589).
type Filtrable<T> = {
  or(filtro: string): T;
  eq(columna: string, valor: unknown): T;
  is(columna: string, valor: null): T;
  not(columna: string, operador: string, valor: unknown): T;
  gte(columna: string, valor: unknown): T;
  lte(columna: string, valor: unknown): T;
};

export function aplicarFiltrosHistorico<T extends Filtrable<T>>(query: T, f: FiltrosHistorico): T {
  let q = query;

  // ── Qué filas existen en esta sección ────────────────────────────────────
  // Esta sección es el histórico de CRUCES, no de la cartera entera: por defecto solo
  // entra lo que el pipeline cruzó. Con el checkbox entran además las cuotas cuyo pago
  // registró el proceso manual en el Excel — tienen fecha_pago pero nunca tuvieron
  // fecha_cruce. Las que no tienen ninguna de las dos (sin pago) no se muestran nunca.
  //
  // 🔴 Y es lo que hace que juntar todas las carteras sea seguro: cada carga es una foto
  // completa, así que la misma llave vive en varias (4.825 de 7.093 llaves aparecen en
  // 2+). Al quedarse con lo cruzado eso se disuelve — una cuota se cruza una vez.
  if (f.incluirExterno) q = q.not("fecha_referencia", "is", null);
  else                  q = q.not("fecha_cruce", "is", null);

  // La misma cláusula de Cartera Preventiva, carácter por carácter (incluida `llave`,
  // que se sumó el 2026-09-02: pegar la llave entera devolvía 0 siendo la primera
  // columna de la tabla).
  if (f.search) {
    q = q.or(`cliente.ilike.%${f.search}%,cruce_access.ilike.%${f.search}%,codigo_transaccion_1.ilike.%${f.search}%,inscrip.ilike.%${f.search}%,llave.ilike.%${f.search}%`);
  }

  // Mismo criterio que Cartera Preventiva: "Resuelta" excluye las ya cerradas, o si no
  // "Cerradas" es un subconjunto suyo y las opciones dejan de partir la lista.
  // "pendiente" ya no puede ocurrir acá (ninguna fila sin pago entra) y por eso el
  // desplegable de la pantalla no lo ofrece; la condición se deja porque no cuesta nada.
  if (f.estado === "resuelta")       q = q.not("fecha_pago", "is", null).is("pago_confirmado", null);
  else if (f.estado === "pendiente") q = q.is("fecha_pago", null);
  else if (f.estado === "cerrada")   q = q.not("pago_confirmado", "is", null);

  // ── La fecha va SIEMPRE sobre fecha_referencia ───────────────────────────
  // Sin el checkbox equivale a fecha_cruce (las demás filas ya quedaron excluidas
  // arriba). Con el checkbox, una fila de fuera se filtra por su FECHA DE PAGO: pedir
  // "25/08" trae lo cruzado ese día MÁS lo pagado ese día.
  //
  // 🔴 Las dos mitades van juntas. Si esto siguiera preguntando por `fecha_cruce`, al
  // poner una fecha las filas de fuera se caerían igual y el checkbox parecería no hacer
  // nada.
  if (f.cruceFrom) q = q.gte("fecha_referencia", f.cruceFrom);
  if (f.cruceTo)   q = q.lte("fecha_referencia", f.cruceTo);

  return q;
}

/**
 * El orden, con desempate obligatorio.
 *
 * 🔴 Ordenar por la fecha a secas pierde filas EN SILENCIO: hay cientos de filas con la
 * misma fecha, y cuando el orden empata Postgres no garantiza el mismo reparto en cada
 * consulta — en el corte entre páginas unas filas salen dos veces y otras no salen nunca.
 * Es el fallo del 5 de agosto: el área bajó 3.017 filas de 3.032 y nadie se enteró.
 * `id` sirve de desempate en la vista unida porque las dos tablas comparten la misma
 * secuencia, así que sus rangos son disjuntos.
 *
 * Se ordena por `fecha_referencia` y no por `fecha_cruce` para que, con el checkbox
 * marcado, las filas de fuera no caigan todas al fondo: se intercalan por su fecha de
 * pago, que es lo que el área está mirando.
 *
 * `nullsFirst: false` a propósito: en DESC, Postgres pone los nulos primero.
 */
export function ordenarHistorico<T extends { order(c: string, o?: { ascending?: boolean; nullsFirst?: boolean }): T }>(query: T): T {
  return query
    .order("fecha_referencia", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true });
}
