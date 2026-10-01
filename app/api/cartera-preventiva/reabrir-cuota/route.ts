import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Reabrir UNA cuota cerrada por el cierre de verdad — el que tiene pago
// asignado (`cerrar-dia` por bloque, o el viejo `cerrar-cuota` por fila).
// Hasta hoy ese cierre no tenía forma de volver atrás desde la pantalla y la
// única salida era una sentencia SQL (pasó el 20/08 con 3991046252 y
// 148PJ46185). Es la INVERSA EXACTA de `cerrar-cuota`, que conviene leer al
// lado: ahí está la fórmula directa.
//
// Reabrir NO corrige la cuota: la devuelve a estado trabajable y las
// correcciones las hace una persona (decisión explícita del usuario).
//
// `cartera_preventiva.pago` es text en el esquema real (no numeric), por eso se
// lee con parseFloat y se escribe como string. valor_cuota/pago_confirmado sí
// son numeric. Mismo helper que `cerrar-cuota`.
const num = (v: string | number | null): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// ⚠️ La app corre en UTC: después de las 19:00 Colombia un `new Date()
// .toISOString()` fecharía la reapertura MAÑANA, y la cuota nacería fuera del
// día que el área va a cerrar. `en-CA` + America/Bogota entrega YYYY-MM-DD,
// que es el formato de la columna `date`.
const hoyColombia = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body  = await req.json().catch(() => ({}));
  const llave = typeof body?.llave === "string" ? body.llave : "";
  if (!llave) return NextResponse.json({ error: "llave requerida" }, { status: 400 });

  const fallo = (error: string, status: number) => {
    // Se loguea también el rechazo, para que "sin entrada en la bitácora"
    // signifique de verdad "no pasó nada" (patrón de `descartar-pago`).
    logAudit({ user_email: user.email ?? "unknown", action: "reabrir_cuota", filters: { llave, error }, result_count: 0 });
    return NextResponse.json({ error }, { status });
  };

  const supabase = createAdminClient();
  const { data: f, error } = await supabase
    .from("cartera_preventiva")
    .select("llave,pago,pago_confirmado,valor_cuota,notificacion")
    .eq("llave", llave)
    .maybeSingle();
  if (error) return fallo(error.message, 500);
  if (!f)    return fallo("Cuota no encontrada", 404);

  // Sin marca de cierre no hay nada que deshacer.
  if (f.pago_confirmado === null) {
    return fallo("La cuota no está cerrada", 400);
  }
  // 🔴 Las cuotas cerradas por "Marcar pagada por Cartera" TAMBIÉN traen
  // `pago_confirmado` (hoy 14 de las 103), así que sin esta guarda caerían por
  // acá. Su cierre vive en un override y es dueño del pipeline: escribirles la
  // fila a mano chocaría con él. Se deshacen por el otro camino
  // (handleReabrirCartera → overrides), que las deja sin Día del Cruce a
  // propósito — no tienen pago real que cruzar.
  if (f.notificacion === "CARTERA") {
    return fallo("Esta cuota se cerró por Cartera: se reabre apagando el cierre manual, no desde acá", 400);
  }

  // Inversa de la fórmula del cierre, que ACUMULA:
  //   nuevoPago = pago − pago_confirmado + valor_pago
  // 🔴 No basta con quitar `pago_confirmado`: el abono que puso el cierre se
  // quedaría en `pago` y el pipeline lo leería como abono traído por el Excel
  // → valor_a_cobrar a $0 y la cuota FUERA del reparto (el problema del 14/08
  // por otra puerta).
  // 🔴 Y no es "poner en cero": hoy ninguna de las 103 trae abono propio del
  // Excel, así que las dos cosas coinciden, pero el día que llegue una cartera
  // con abonos el cero borraría plata que el proceso manual ya cobró.
  const abonoPrevio = num(f.pago) - num(f.pago_confirmado);

  // Una sola escritura con los cuatro campos: partirla dejaría la cuota con el
  // abono puesto y sin marca de cierre, que es el peor estado posible.
  const { error: updErr } = await supabase
    .from("cartera_preventiva")
    .update({
      pago: abonoPrevio === 0 ? null : String(abonoPrevio),
      valor_a_cobrar: num(f.valor_cuota) - abonoPrevio,
      pago_confirmado: null,
      // El día en que se reabre, no el original: el área cierra cartera
      // filtrando por Día del Cruce un día exacto cada mañana, así que una
      // cuota reabierta que conserve su fecha vieja queda fuera de todos los
      // cierres futuros y sin forma de alcanzarla desde la pantalla.
      // ⚠️ Efecto a avisarle al área: la cuota SALE del reporte de su día
      // original.
      fecha_cruce: hoyColombia(),
    })
    .eq("llave", llave);
  if (updErr) return fallo(updErr.message, 500);

  await logAudit({ user_email: user.email ?? "unknown", action: "reabrir_cuota", filters: { llave, abono_previo: abonoPrevio }, result_count: 1 });
  return NextResponse.json({ ok: true });
}
