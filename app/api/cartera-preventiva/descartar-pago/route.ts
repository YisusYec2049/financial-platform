import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Regla #3 (Spec Auto Cartera): descartar un pago ya asociado a una cuota.
// Borra la asociación puntual (matching_key P ↔ llave A) y deja el monto
// descartado como saldo a favor del cliente (origen='descarte'), asociable
// después con el flujo #7. El pipeline es quien resetea la cuota A a
// pendiente y excluye P de la auto-aplicación en su próxima corrida — esta
// app solo registra la decisión, mismo patrón que el resto del rediseño.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const asociacionId = Number(body?.asociacion_id);
  const llave         = body?.llave as string | undefined;
  const matchingKey   = body?.matching_key as string | undefined;
  const documento     = body?.documento as string | undefined;
  const correo        = (body?.correo as string | undefined) ?? null;
  const cliente       = (body?.cliente as string | undefined) ?? null;
  const inscrip       = (body?.inscrip as string | undefined) ?? null;

  if (!Number.isFinite(asociacionId) || !llave || !matchingKey || !documento) {
    return NextResponse.json({ error: "asociacion_id, llave, matching_key y documento son requeridos" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: asociacion, error: fetchError } = await supabase
    .from("pago_asociaciones")
    .select("id, matching_key, llave, monto")
    .eq("id", asociacionId)
    .maybeSingle();

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!asociacion) return NextResponse.json({ error: "Asociación no encontrada" }, { status: 404 });
  if (asociacion.matching_key !== matchingKey || asociacion.llave !== llave) {
    return NextResponse.json({ error: "La asociación no coincide con el pago/cuota indicados" }, { status: 400 });
  }

  const monto = Number(asociacion.monto);

  // Registrar la plata y soltar el vínculo son UNA SOLA transacción (sql/025).
  // Antes eran dos escrituras sueltas y en el orden inverso: si la cuota ya
  // tenía un saldo de ese mismo pago (el sobrante que dejó el pipeline), el
  // insert chocaba contra `unique (matching_key, llave_origen)` y devolvía 500
  // con el vínculo ya borrado — la plata se perdía sin dejar rastro. La función
  // registra primero (sumando al saldo existente si lo hay) y borra después.
  const { error: rpcError } = await supabase.rpc("descartar_pago", {
    p_asociacion_id: asociacionId,
    p_documento: documento,
    p_correo: correo,
    p_cliente: cliente,
    p_inscrip: inscrip,
  });

  if (rpcError) {
    // La transacción se deshizo entera: no se borró nada. Se loguea el fallo
    // para que "sin entrada en la bitácora" signifique de verdad "no pasó nada".
    logAudit({
      user_email: user.email ?? "unknown",
      action: "delete",
      filters: { asociacion_id: asociacionId, matching_key: matchingKey, llave, error: rpcError.message, view: "pago_asociaciones+cartera_saldos_favor" },
      result_count: 0,
    });
    return NextResponse.json({ error: rpcError.message }, { status: 500 });
  }

  logAudit({
    user_email: user.email ?? "unknown",
    action: "delete",
    filters: { asociacion_id: asociacionId, matching_key: matchingKey, llave, monto, view: "pago_asociaciones+cartera_saldos_favor" },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
