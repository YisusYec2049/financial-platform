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

  const { error: deleteError } = await supabase
    .from("pago_asociaciones")
    .delete()
    .eq("id", asociacionId);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  const { error: insertError } = await supabase
    .from("cartera_saldos_favor")
    .insert({
      origen: "descarte",
      matching_key: matchingKey,
      llave_origen: llave,
      documento,
      correo,
      cliente,
      inscrip,
      monto,
      disponible: monto,
      fecha: new Date().toISOString().slice(0, 10),
      aplicado: false,
    });
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "delete",
    filters: { asociacion_id: asociacionId, matching_key: matchingKey, llave, monto, view: "pago_asociaciones+cartera_saldos_favor" },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
