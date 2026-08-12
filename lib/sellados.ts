import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Pagos SELLADOS: los que llegaron a la corrida diaria del día siguiente sin
 * haberse aplicado a ninguna cuota. El pipeline los marca con
 * `cruce_cartera.aplicacion_cerrada_at` (regla del usuario del 5 de agosto) y no
 * los vuelve a aplicar solo. Esta app tiene que cumplir las otras dos mitades de
 * esa regla: no se pueden asociar a mano y no se muestran como saldo a favor.
 *
 * Devuelve un Map matching_key → fecha del sello, para poder decirlo con
 * palabras en el mensaje de rechazo.
 *
 * ⚠️ Dos trampas que no hay que "simplificar":
 *
 *  1. **Por lotes de 200, y el arreglo va a `.in()`.** Un `.in()` con muchas
 *     llaves puede volver cortado SIN error (la misma trampa que la paginación,
 *     5 de agosto), y un pago que vuelve cortado se leería como "no sellado" —
 *     justo al revés de lo que hay que proteger. Nunca interpolado dentro de un
 *     `.or()`: las llaves de Bancolombia llevan barras y paréntesis
 *     (`… (duplicado)`), que en un string de filtros rompen la consulta.
 *
 *  2. **"No está en `cruce_cartera`" NO es "sellado".** Un pago apartado
 *     (matrícula, cesantías, cheque) se borra de esa tabla a propósito. Tratar la
 *     ausencia como sello haría desaparecer esos pagos del panel sin que nadie lo
 *     pidiera. Solo cuenta la fila que existe Y trae `aplicacion_cerrada_at`.
 */
export async function fetchSellados(
  supabase: Admin,
  matchingKeys: (string | null | undefined)[],
): Promise<{ sellados: Map<string, string>; error: string | null }> {
  const sellados = new Map<string, string>();
  const claves = [...new Set(matchingKeys.filter((k): k is string => !!k))];

  for (let i = 0; i < claves.length; i += 200) {
    const lote = claves.slice(i, i + 200);
    const { data, error } = await supabase
      .from("cruce_cartera")
      .select("matching_key, aplicacion_cerrada_at")
      .in("matching_key", lote)
      .not("aplicacion_cerrada_at", "is", null);
    if (error) return { sellados, error: error.message };
    for (const r of data ?? []) {
      sellados.set(r.matching_key as string, String(r.aplicacion_cerrada_at));
    }
  }

  return { sellados, error: null };
}
