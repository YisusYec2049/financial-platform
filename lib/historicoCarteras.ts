import { sanitizeSearch } from "@/lib/search";

/**
 * Los filtros del Histórico de Carteras, en UN solo sitio.
 *
 * 🔴 La lista y la descarga tienen que leer exactamente lo mismo, incluido el selector
 * de cartera. Copiar la cláusula en las dos rutas es justo lo que se desincroniza: el
 * 3 de agosto "Cerrar Cartera" ignoraba el filtro de Día del Cruce y cerraba lo de hoy,
 * y el 19 "Le falta plata" alcanzaba 218 cuotas en vez de 15. Acá no hay pantalla que
 * escriba nada (la sección es de solo lectura), pero el Excel es el entregable del área
 * y tiene que traer lo que la pantalla dice que trae.
 */

/** La cartera viva no tiene `carga_id` — solo el archivo lo tiene. Se identifica con
 *  este literal, y NO se inventa un carga_id para ella. */
export const CARTERA_VIVA = "viva";

export type FiltrosHistorico = {
  cartera: string;
  search: string;
  estado: string;
  cruceFrom: string;
  cruceTo: string;
};

export function parseFiltrosHistorico(sp: URLSearchParams): FiltrosHistorico {
  return {
    cartera:   sp.get("cartera")?.slice(0, 100) || CARTERA_VIVA,
    search:    sanitizeSearch(sp.get("search")),
    estado:    sp.get("estado") || "todas",
    cruceFrom: sp.get("cruce_from") || "",
    cruceTo:   sp.get("cruce_to") || "",
  };
}

/** `viva` → la tabla de trabajo; cualquier otro valor → el archivo, acotado por carga_id. */
export function tablaDeCartera(cartera: string): string {
  return cartera === CARTERA_VIVA ? "cartera_preventiva" : "cartera_preventiva_archivo";
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

  // Solo la tabla de archivo tiene carga_id; la viva es una sola y no se acota.
  if (f.cartera !== CARTERA_VIVA) q = q.eq("carga_id", f.cartera);

  // La misma cláusula de Cartera Preventiva, carácter por carácter (incluida `llave`,
  // que se sumó el 2026-09-02: pegar la llave entera devolvía 0 siendo la primera
  // columna de la tabla).
  if (f.search) {
    q = q.or(`cliente.ilike.%${f.search}%,cruce_access.ilike.%${f.search}%,codigo_transaccion_1.ilike.%${f.search}%,inscrip.ilike.%${f.search}%,llave.ilike.%${f.search}%`);
  }

  // Mismo criterio que Cartera Preventiva: "Resuelta" excluye las ya cerradas, o si no
  // "Cerradas" es un subconjunto suyo y las tres opciones dejan de partir la cartera.
  if (f.estado === "resuelta")      q = q.not("fecha_pago", "is", null).is("pago_confirmado", null);
  else if (f.estado === "pendiente") q = q.is("fecha_pago", null);
  else if (f.estado === "cerrada")   q = q.not("pago_confirmado", "is", null);

  // El filtro que motivó todo el requerimiento: el área lleva su traza diaria por acá.
  if (f.cruceFrom) q = q.gte("fecha_cruce", f.cruceFrom);
  if (f.cruceTo)   q = q.lte("fecha_cruce", f.cruceTo);

  return q;
}

/**
 * El orden, con desempate obligatorio.
 *
 * 🔴 Ordenar por `fecha_cruce` a secas pierde filas EN SILENCIO: en una cartera hay
 * cientos de filas con la misma fecha (y miles con la fecha vacía), y cuando el orden
 * empata Postgres no garantiza el mismo reparto en cada consulta — en el corte entre
 * páginas unas filas salen dos veces y otras no salen nunca. Es el fallo del 5 de
 * agosto: el área bajó 3.017 filas de 3.032 y nadie se enteró.
 *
 * `nullsFirst: false` a propósito: en DESC, Postgres pone los nulos primero, y en una
 * cartera son miles — la traza que el área viene a ver quedaría enterrada.
 */
export function ordenarHistorico<T extends { order(c: string, o?: { ascending?: boolean; nullsFirst?: boolean }): T }>(query: T): T {
  return query
    .order("fecha_cruce", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true });
}
