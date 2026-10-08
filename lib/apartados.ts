import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * El nombre de cada categoría, en un solo sitio. Lo leen las DOS pantallas y la
 * descarga del Consolidado: hasta hoy había una copia en `TransactionsView` y
 * otra en `PagosApartadosView`, y la del 4 de septiembre ya había costado un
 * badge saliendo en crudo (`numeros_uc`) por tocar una y no la otra.
 *
 * 🔴 Lleva `?? tipo` en todos los usos a propósito: si el pipeline inventa un
 * tipo que esta versión no conoce, se ve el valor crudo — nunca vacío.
 */
export const CATEGORIA_LABEL: Record<string, string> = {
  normal: "Normal",
  matricula: "Matrícula",
  cesantias: "Cesantías",
  pago_llave: "Pago por llave",
  numeros_uc: "Números de UC",
  cheque: "Cheque",
  otros: "Otros",
};

/** Lo que se lee en pantalla y en el Excel: `Otros · Certificado`. */
export function etiquetaCategoria(tipo: string, motivo?: string | null): string {
  const base = CATEGORIA_LABEL[tipo] ?? tipo;
  const m = (motivo ?? "").trim();
  return tipo === "otros" && m ? `${base} · ${m}` : base;
}

/** Lo que el Consolidado necesita saber de un pago apartado. */
export type Apartado = { tipo: string; nota: string | null };

/**
 * La categoría de un pago apartado, tal como se filtra y se muestra: el `tipo`,
 * y para los de "Otros" el **motivo** pegado detrás (`otros:Certificado`).
 *
 * 🔴 El motivo es parte de la categoría, no un comentario al margen. Hasta el
 * 8/10/2026 los 111 pagos de "Otros" se veían todos iguales en la pantalla y en
 * el filtro, cuando por dentro eran ~8 cosas distintas (certificados, Nequi,
 * pagos errados…). Un pago de "Otros" sin motivo cae en `otros` pelado.
 */
export function categoriaDe(a: Apartado): string {
  if (a.tipo !== "otros") return a.tipo;
  const motivo = (a.nota ?? "").trim();
  return motivo ? `otros:${motivo}` : "otros";
}

/**
 * ¿Esta fila entra en el filtro elegido? `otros` trae TODOS los motivos y
 * `otros:Certificado` solo el suyo — si no, elegir "Otros" dejaría fuera justo
 * los 111 pagos que tienen motivo, que son todos.
 */
export function coincideCategoria(categoria: string, filtro: string): boolean {
  return categoria === filtro || categoria.startsWith(`${filtro}:`);
}

/**
 * Parte el valor del filtro en sus dos piezas: `otros:Certificado` → tipo
 * `otros` + motivo `Certificado`. Lo usan las dos rutas de Pagos Apartados, que
 * filtran contra columnas (`tipo` y `nota`) y no contra la categoría compuesta.
 *
 * 🔴 Se corta en el PRIMER `:` nada más: un motivo puede llevar dos puntos
 * adentro ("Pago errado: devuelto"), y partirlo entero lo dejaría sin encontrar
 * su propia fila.
 */
export function partirCategoria(filtro: string): { tipo: string; motivo: string | null } {
  const i = filtro.indexOf(":");
  if (i === -1) return { tipo: filtro, motivo: null };
  return { tipo: filtro.slice(0, i), motivo: filtro.slice(i + 1) };
}

/**
 * Huella de un motivo, para no crear dos categorías que son la misma: sin
 * tildes, sin puntuación y en minúsculas. Es lo que hace que escribir
 * "certificado." elija el "Certificado" que ya existe — el defecto que tenía el
 * campo libre, donde esa palabra entró de NUEVE formas distintas.
 */
export function huellaMotivo(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** El nombre con el que se guarda un motivo nuevo: espacios y punto final fuera. */
export function normalizarMotivo(nombre: string): string {
  const limpio = nombre.trim().replace(/\s+/g, " ").replace(/\.+$/, "").trim();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

/**
 * Pagos APARTADOS: los que salen del proceso de cruce (matrícula, cesantías, pago
 * por llave, cheque, números de UC, otros). Devuelve un Map matching_key → tipo,
 * que es con lo que el Consolidado pinta la columna Categoría y con lo que filtra
 * por ella.
 *
 * ⚠️ Dos trampas que no hay que "simplificar":
 *
 *  1. **Paginado a propósito.** PostgREST devuelve 1.000 filas como máximo y NO
 *     avisa (invariante 3.2). Esta tabla se traía con un `select` suelto y un
 *     comentario que decía "es chica (decenas de filas hoy)"; al 8/10/2026 son
 *     ~1.476 filas, así que el mapa nacía sin ~476 pagos y cada uno de ellos se
 *     pintaba "Normal" en el Consolidado, con su botón de apartar al lado — y el
 *     filtro "Normal" los incluía como normales, porque la exclusión se arma con
 *     las llaves que este mapa alcanzó a ver.
 *  2. **El desempate por `matching_key` es obligatorio** (invariante 3.1). Es la PK
 *     de esta tabla, que **no tiene `id`**: sin orden estable, el corte entre
 *     páginas repite filas y se salta otras, sin error y sin aviso.
 */
export async function fetchApartados(
  supabase: Admin,
): Promise<{ apartados: Map<string, Apartado>; error: string | null }> {
  const apartados = new Map<string, Apartado>();
  const BATCH = 1000;

  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("pagos_apartados")
      .select("matching_key, tipo, nota")
      .order("matching_key", { ascending: true })
      .range(from, from + BATCH - 1);
    if (error) return { apartados, error: error.message };
    for (const a of data ?? []) {
      apartados.set(a.matching_key as string, {
        tipo: a.tipo as string,
        nota: (a.nota as string | null) ?? null,
      });
    }
    if (!data || data.length < BATCH) break;
  }

  return { apartados, error: null };
}

/**
 * Los motivos que puede elegir quien aparta: el catálogo (`apartados_motivos`)
 * MÁS los que ya están en uso en `pagos_apartados`.
 *
 * 🔴 La unión no es por completitud: los 111 pagos viejos traen notas que nunca
 * se van a volver a elegir ("Pago ya identificado 19/08/2026") y que a propósito
 * no entraron al catálogo. Si el filtro saliera solo del catálogo, esos pagos
 * **no se podrían filtrar por el motivo que la pantalla les muestra**.
 */
export async function fetchMotivos(supabase: Admin): Promise<{
  motivos: { nombre: string; enCatalogo: boolean; usos: number }[];
  catalogoDisponible: boolean;
  error: string | null;
}> {
  const { data: cat, error: errCat } = await supabase
    .from("apartados_motivos")
    .select("nombre")
    .eq("activo", true)
    .order("nombre");

  // 🔴 Si la tabla todavía no existe (el SQL de este cambio va antes del
  // despliegue, pero lo corre una persona), NO se cae nada: la lista sale de los
  // motivos que ya están en uso y apartar como "Otros" sigue funcionando como
  // siempre. Un cambio de pantalla no puede dejar al área sin poder apartar un
  // pago por una tabla que falta.
  const faltaLaTabla =
    !!errCat && /does not exist|schema cache|42P01|PGRST205/i.test(errCat.message ?? "");
  if (errCat && !faltaLaTabla) return { motivos: [], catalogoDisponible: false, error: errCat.message };

  const { apartados, error: errAp } = await fetchApartados(supabase);
  if (errAp) return { motivos: [], catalogoDisponible: !faltaLaTabla, error: errAp };

  const usos = new Map<string, number>();
  for (const a of apartados.values()) {
    if (a.tipo !== "otros") continue;
    const motivo = (a.nota ?? "").trim();
    if (motivo) usos.set(motivo, (usos.get(motivo) ?? 0) + 1);
  }

  const nombres = new Map<string, boolean>();
  for (const r of cat ?? []) nombres.set(r.nombre as string, true);
  for (const nombre of usos.keys()) if (!nombres.has(nombre)) nombres.set(nombre, false);

  const motivos = [...nombres.entries()]
    .map(([nombre, enCatalogo]) => ({ nombre, enCatalogo, usos: usos.get(nombre) ?? 0 }))
    .sort((a, b) => b.usos - a.usos || a.nombre.localeCompare(b.nombre, "es"));

  return { motivos, catalogoDisponible: !faltaLaTabla, error: null };
}
