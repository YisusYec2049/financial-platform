// lib/monto.ts

/**
 * Parsea un monto escrito con "." como separador de miles (formato Colombia):
 *   "528.000"      -> 528000
 *   "$ 1.234.567"  -> 1234567
 *   "896182"       -> 896182
 *   ""             -> NaN
 * Quita todo lo que no sea dígito. COP no maneja centavos en estos montos, así
 * que no hay separador decimal que preservar. Si en el futuro hiciera falta
 * (ej. USD de Stripe), este helper es el único punto a extender.
 */
export function parseMonto(s: string | number | null | undefined): number {
  if (typeof s === "number") return s;
  const digits = String(s ?? "").replace(/[^\d]/g, "");
  return digits === "" ? NaN : Number(digits);
}

/**
 * Formatea un entero como monto con "." de miles, SIN símbolo ni decimales:
 *   528000 -> "528.000"
 * Pensado para mostrar el valor DENTRO de un input de texto (al perder foco).
 * Para celdas de solo lectura seguir usando el `fmtMonto` es-CO de cada vista.
 */
export function formatMonto(n: number | string | null | undefined): string {
  const v = parseMonto(n as string);
  return Number.isFinite(v) ? v.toLocaleString("es-CO") : "";
}
