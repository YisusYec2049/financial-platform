import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Cuotas CERRADAS A MANO: las que alguien declaró "pagada por Cartera" desde la
 * pantalla. La decisión vive en `cartera_preventiva_overrides.cerrado_manual` y la
 * APLICA el pipeline en su próxima corrida (invariante 2.1).
 *
 * Por eso existe este helper: entre el clic del cierre y el final del reproceso,
 * `cartera_preventiva` todavía no refleja nada — `fecha_pago` sigue en NULL, el
 * medio de pago sigue vacío y `notificacion` no dice `CARTERA`. En esa ventana la
 * cuota se seguía ofreciendo como destino de asociación y el guardado la aceptaba:
 * el 2 de octubre el doc `1099208759` quedó con la cuota `614PN46254` declarada
 * cobrada por Cartera Y consumiendo un pago de $1.040.000, con 29 segundos entre
 * los dos clics. Cobrada dos veces, y sin rastro en ninguna celda de la fila —
 * desde que la cuota se cierra el pipeline la salta en todas sus pasadas.
 *
 * ⚠️ Tres trampas que no hay que "simplificar":
 *
 *  1. **La señal es el OVERRIDE, no la cuota.** Preguntarle a `cartera_preventiva`
 *     por `fecha_pago`, `pago_confirmado` o `medio_pago = 'Cartera'` no sirve: en
 *     la ventana la cuota no trae ninguna de las tres. Ese es el hueco entero.
 *  2. **Por lotes de 200**, como `lib/sellados.ts`: un `.in()` largo puede volver
 *     cortado SIN error, y una llave que vuelve cortada se lee como "no cerrada" —
 *     justo al revés de lo que hay que proteger.
 *  3. **`cerrado_manual` es `boolean` y puede valer `false`** (reabrir lo apaga, no
 *     borra la fila): el filtro es `= true`, nunca "existe la fila".
 *
 * Sin `llaves`, devuelve TODAS las cerradas a mano de la cartera viva (hoy 27, de
 * 43 overrides) — es lo que necesita `multi-inscripcion`, que recorre la cartera
 * entera y no tiene una lista de llaves a la que preguntar.
 */
export async function fetchCerradasManual(
  supabase: Admin,
  llaves?: (string | null | undefined)[],
): Promise<{ cerradas: Set<string>; error: string | null }> {
  const cerradas = new Set<string>();

  if (llaves === undefined) {
    // Tabla chica, pero paginada igual y con desempate por `llave` (su PK): el día
    // que pase de 1.000 filas, PostgREST corta en 1.000 y NO avisa (invariante 3.2),
    // y acá eso se traduce en volver a ofrecer una cuota cerrada.
    const BATCH = 1000;
    for (let from = 0; ; from += BATCH) {
      const { data, error } = await supabase
        .from("cartera_preventiva_overrides")
        .select("llave")
        .eq("cerrado_manual", true)
        .order("llave", { ascending: true })
        .range(from, from + BATCH - 1);
      if (error) return { cerradas, error: error.message };
      for (const r of data ?? []) cerradas.add(r.llave as string);
      if (!data || data.length < BATCH) break;
    }
    return { cerradas, error: null };
  }

  const claves = [...new Set(llaves.filter((l): l is string => !!l))];
  for (let i = 0; i < claves.length; i += 200) {
    const lote = claves.slice(i, i + 200);
    const { data, error } = await supabase
      .from("cartera_preventiva_overrides")
      .select("llave")
      .in("llave", lote)
      .eq("cerrado_manual", true);
    if (error) return { cerradas, error: error.message };
    for (const r of data ?? []) cerradas.add(r.llave as string);
  }

  return { cerradas, error: null };
}

/** El mensaje de rechazo, idéntico en las dos puertas por las que entra plata. */
export const ERROR_CERRADA_POR_CARTERA =
  "Esta cuota ya está declarada pagada por Cartera. Para ponerle un pago, primero hay que reabrirla.";
