import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// "Deshacer envío": un documento mal escrito manda plata a la pantalla de un
// desconocido, y sin esto solo se saca por base de datos. Sirve para los DOS tipos
// de traslado (desde el ledger y desde el restante libre de un pago).
//
// ⚠️ NO es un simple borrado, y por eso vive en una función de base. Un traslado
// desde el ledger le RESTÓ el monto a la fila de origen; borrar la fila trasladada
// sin devolvérselo hace desaparecer la plata. `deshacer_traslado_saldo()` mira
// `trasladado_de` y hace las dos cosas en una transacción, con el candado del pago
// tomado — si el traslado vino del restante libre no hay a quién devolverle nada y
// basta con borrar, porque ese restante se recalcula solo.
//
// Las dos condiciones (`origen='traslado'`, e intacto: `aplicado=false` y
// `disponible = monto`) las revalida la función releyendo la fila bloqueada, así
// que una pantalla vieja no puede colarse. Si ya se asoció algo, el camino es
// "Descartar pago" en la cuota destino, como siempre.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const saldoId = Number(body?.saldo_id);
  if (!Number.isFinite(saldoId)) {
    return NextResponse.json({ error: "saldo_id es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Solo para la bitácora, antes de que la fila desaparezca: a quién se le había
  // mandado la plata y por cuánto.
  const { data: saldo } = await supabase
    .from("cartera_saldos_favor")
    .select("matching_key, documento, monto, trasladado_de")
    .eq("id", saldoId)
    .maybeSingle();

  const { error } = await supabase.rpc("deshacer_traslado_saldo", { p_saldo_id: saldoId });

  const filtros = {
    saldo_id: saldoId,
    matching_key: saldo?.matching_key ?? null,
    documento_destino: saldo?.documento ?? null,
    monto: saldo?.monto ?? null,
    trasladado_de: saldo?.trasladado_de ?? null,
  };

  if (error) {
    logAudit({
      user_email: user.email ?? "unknown",
      action: "delete",
      filters: { ...filtros, view: "deshacer_traslado_saldo", error: error.message },
      result_count: 0,
    });
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  logAudit({
    user_email: user.email ?? "unknown",
    action: "delete",
    filters: { ...filtros, view: "cartera_saldos_favor (deshacer traslado)" },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
