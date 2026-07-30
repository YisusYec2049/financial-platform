/**
 * Sanea el texto del buscador antes de interpolarlo en un `.or(...)` de PostgREST.
 *
 * El valor entra crudo dentro de un string de filtros, así que hay dos familias de
 * caracteres que no pueden pasar:
 *   - `,` `(` `)` son los separadores del lenguaje de filtros. Una coma escrita en el
 *     campo parte la cláusula en dos y la consulta falla con PGRST100 (la vista queda
 *     sin datos, sin explicación).
 *   - `%` y `*` son comodines de `ilike`. Escribir uno solo devuelve la tabla entera.
 *
 * `_` (el comodín de un carácter en SQL LIKE) se deja pasar a propósito: vive dentro de
 * los VAL de WOMPI (`7l5Lun_1784234831958_v85o8r5h86`) y de las llaves de Bancolombia
 * (`16/07/2026_816002330_2457251`), así que quitarlo rompería justo lo que el buscador
 * tiene que encontrar. Que ensanche la búsqueda no hace daño: todas las rutas que
 * comparten un filtro (lista, descarga y "Cerrar Cartera") arman la MISMA cláusula, así
 * que el conjunto que se ve y el que se escribe siguen siendo el mismo.
 */
export function sanitizeSearch(raw: string | null | undefined): string {
  return (raw || "").slice(0, 100).replace(/[,()*%]/g, " ").trim();
}
