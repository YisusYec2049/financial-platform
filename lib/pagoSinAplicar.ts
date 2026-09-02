// El aviso "PAGO SIN APLICAR" (spec del 2026-08-21).
//
// Desde el 21 de agosto el pipeline reparte POR PAGO, no por cuota. Cuando una
// cuota queda corta por MENOS del umbral ($50.000 / 15 USD) no nace su cuota de
// deuda, y entonces el pago siguiente no se le suma a la cuota (eso es justo lo
// que se dejó de hacer) ni se salta a la cuota que sigue, porque hay una deuda
// viva. Esa plata queda esperando a que una persona la asocie a mano, y el
// pipeline lo avisa escribiendo en `cartera_preventiva.notificacion`:
//
//     PAGO SIN APLICAR $33.600        (en una cuota en dólares: 18 USD)
//
// El monto viaja DENTRO del texto y cambia con él, así que todo lo que mire este
// aviso tiene que hacerlo por PREFIJO, nunca por igualdad. El pipeline lo limpia
// solo en cuanto el pago se asocia o la cuota deja de estar corta.
//
// Un solo sitio para las dos formas de preguntarlo porque son 6 archivos los que
// lo consultan —la lista, la descarga y `cerrar-dia` tienen que quedar idénticas
// carácter por carácter, o "Cerrar Cartera" escribe sobre un conjunto distinto
// del que la persona está viendo (el fallo del 2026-08-03)—.
export const PAGO_SIN_APLICAR = "PAGO SIN APLICAR";

// Para PostgREST. El comodín va como `*` (PostgREST lo traduce a `%`), y el
// patrón lleva espacios: verificado contra producción que funciona tanto suelto
// (`notificacion=like.…`) como dentro de un `.or(...)`.
export const LIKE_PAGO_SIN_APLICAR = `${PAGO_SIN_APLICAR}*`;

// Para el navegador.
export const esPagoSinAplicar = (notificacion: string | null | undefined) =>
  (notificacion ?? "").startsWith(PAGO_SIN_APLICAR);
