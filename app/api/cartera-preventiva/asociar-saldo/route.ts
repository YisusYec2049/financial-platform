import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Regla #7 (Spec Auto Cartera): asociar un saldo a favor (cartera_saldos_favor,
// ya no se auto-aplica) a una cuota destino elegida a mano. Escribe
// pago_asociaciones (mismo contrato que el panel de asociar de §4.1: el
// pipeline es quien escribe el cierre de la cuota destino en su próxima
// corrida) y decrementa disponible en el ledger — si llega a 0, aplicado pasa
// a true (igual que hace el pipeline cuando el sobrante se consume solo).
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

  const { data: saldo, error: saldoError } = await supabase
    .from("cartera_saldos_favor")
    .select("id, matching_key, disponible, aplicado")
    .eq("id", saldoId)
    .maybeSingle();

  if (saldoError) return NextResponse.json({ error: saldoError.message }, { status: 500 });
  if (!saldo) return NextResponse.json({ error: "Saldo a favor no encontrado" }, { status: 404 });
  if (saldo.aplicado) return NextResponse.json({ error: "Este saldo ya fue aplicado" }, { status: 400 });
  if (monto > Number(saldo.disponible) + 0.01) {
    return NextResponse.json({ error: "El monto excede el saldo disponible" }, { status: 400 });
  }

  const { error: insertError } = await supabase
    .from("pago_asociaciones")
    .insert({ matching_key: saldo.matching_key, llave, monto, origen: "manual" });
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  const nuevoDisponible = Math.max(0, Number(saldo.disponible) - monto);
  const { error: updateError } = await supabase
    .from("cartera_saldos_favor")
    .update({ disponible: nuevoDisponible, aplicado: nuevoDisponible <= 0.01 })
    .eq("id", saldoId);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "insert",
    filters: { saldo_id: saldoId, matching_key: saldo.matching_key, llave, monto, view: "pago_asociaciones+cartera_saldos_favor" },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
