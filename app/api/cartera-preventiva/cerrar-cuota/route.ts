import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Cierre de UNA cuota: copia el valor_pago identificado al campo `pago`, que es
// como el Sistema Financiero representa una cuota cobrada. Misma escritura que
// hace `cerrar-dia` en bloque, pero para una sola llave.
//
// `cartera_preventiva.pago` es text en el esquema real (no numeric), por eso se
// escribe como string. valor_cuota/valor_pago/pago_confirmado sí son numeric.
const num = (v: string | number | null): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body  = await req.json().catch(() => ({}));
  const llave = typeof body?.llave === "string" ? body.llave : "";
  if (!llave) return NextResponse.json({ error: "llave requerida" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: f, error } = await supabase
    .from("cartera_preventiva")
    .select("llave,pago,pago_confirmado,valor_cuota,valor_pago")
    .eq("llave", llave)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!f)    return NextResponse.json({ error: "Cuota no encontrada" }, { status: 404 });

  // Nada que copiar (sin pago identificado) → no se puede cerrar así. Para esas
  // cuotas está el cierre manual "Marcar pagada por Cartera" (overrides).
  if (f.valor_pago === null) {
    return NextResponse.json({ error: "La cuota no tiene un pago identificado para cerrar" }, { status: 400 });
  }
  // Ya cerrada → idempotente, darle dos veces no hace daño.
  if (num(f.pago_confirmado) === num(f.valor_pago)) {
    return NextResponse.json({ ok: true, yaCerrada: true });
  }

  const valorPago = num(f.valor_pago);

  // GUARDA (no está en el spec, medida contra producción): el Excel ya trae el
  // pago reflejado en `pago` en 1136 de las 1553 cuotas candidatas — ahí `pago`
  // y `valor_pago` ya son el mismo número, o difieren en centavos. Como la
  // fórmula ACUMULA, cerrarlas duplicaría el pago y dejaría `valor_a_cobrar`
  // negativo. No es problema para "Cerrar Cartera" (acotado a fecha_cruce=hoy,
  // que el Excel todavía no refleja) pero sí para el cierre por fila, que
  // alcanza cuotas viejas. Tolerancia de 100 = la misma del pipeline, cubre los
  // centavos del Excel (ej. pago 485086.5 vs valor_pago 485086).
  if (Math.abs(num(f.pago) - valorPago) <= 100) {
    return NextResponse.json({
      ok: true,
      yaReflejado: true,
      mensaje: "El Sistema Financiero ya registra esta cuota como cobrada (Pago = Valor pagado). No se modificó nada.",
    });
  }
  // `pago` ACUMULA: se resta lo que puso un cierre anterior (pago_confirmado) y
  // se suma el valor_pago actual, para no pisar el abono que traía el Excel.
  const nuevoPago = num(f.pago) - num(f.pago_confirmado) + valorPago;
  const { error: updErr } = await supabase
    .from("cartera_preventiva")
    .update({
      pago: String(nuevoPago),
      // Invariante, no se fuerza a 0: si pagó de menos el faltante queda a la
      // vista, que es lo que el equipo usa para repartir la deuda.
      valor_a_cobrar: num(f.valor_cuota) - nuevoPago,
      pago_confirmado: valorPago,
    })
    .eq("llave", llave);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await logAudit({ user_email: user.email ?? "unknown", action: "cerrar_cuota", filters: { llave }, result_count: 1 });
  return NextResponse.json({ ok: true });
}
