import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Regla #7 (Spec Auto Cartera): asociar un saldo a favor (cartera_saldos_favor,
// ya no se auto-aplica) a una cuota destino elegida a mano. Escribe
// pago_asociaciones (mismo contrato que el panel de asociar de §4.1: el
// pipeline es quien escribe el cierre de la cuota destino en su próxima
// corrida) y decrementa disponible en el ledger.
//
// Las dos escrituras son UNA sola llamada a la función asociar_saldo() (spec
// 30/07), por dos motivos:
//  1. Si el pago del saldo YA tenía vínculo con esta cuota, hay que SUMAR al
//     monto existente, no insertar otra fila: pago_asociaciones tiene
//     unique (matching_key, llave), así que el insert seco reventaba con
//     "duplicate key". Y reemplazar borraría lo que ese mismo pago ya aplicó.
//  2. Sueltas, si la segunda falla la plata queda contada dos veces (aplicada
//     a la cuota y todavía disponible). La función además bloquea la fila del
//     ledger, así que dos clics simultáneos no pueden gastar el mismo saldo.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const saldoId = Number(body?.saldo_id);
  const llave   = body?.llave as string | undefined;
  const monto   = Number(body?.monto);

  if (!Number.isFinite(saldoId) || !llave || !Number.isFinite(monto) || monto <= 0) {
    return NextResponse.json({ error: "saldo_id, llave y monto (> 0) son requeridos" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Validar, vincular y descontar: o pasan las tres o no pasa ninguna. Las
  // validaciones viven dentro de la función, donde no se pueden esquivar.
  const { data, error } = await supabase.rpc("asociar_saldo", {
    p_saldo_id: saldoId,
    p_llave:    llave,
    p_monto:    monto,
  });

  if (error) {
    // El fallo TAMBIÉN se registra: un error silencioso acá fue la mitad más
    // difícil del bug del descarte (27 de julio), donde la bitácora decía que
    // nadie había hecho nada.
    logAudit({
      user_email: user.email ?? "unknown",
      action: "insert",
      filters: { saldo_id: saldoId, llave, monto, view: "asociar_saldo", error: error.message },
      result_count: 0,
    });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  logAudit({
    user_email: user.email ?? "unknown",
    action: "insert",
    filters: { saldo_id: saldoId, llave, monto, view: "pago_asociaciones+cartera_saldos_favor" },
    result_count: 1,
  });

  return NextResponse.json({ success: true, ...data });
}
