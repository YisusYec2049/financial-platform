import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// El toggle "es la última cuota" (spec Sobrantes-Excedentes §1) es el único
// estado de esta tabla que la propia UI necesita leer de vuelta (para pintar
// el botón como ya marcado/no marcado) — cierre manual y valor de cuota no lo
// necesitaban porque su efecto se ve solo, en fecha_pago/valor_cuota una vez
// que el pipeline los aplica. Tabla chica (solo filas tocadas a mano), un
// solo select sin paginar alcanza.
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cartera_preventiva_overrides")
    .select("llave")
    .eq("es_ultima_cuota", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ llaves: (data || []).map((r) => r.llave as string) });
}

// Cierre manual (§4.2), valor cuota editable (§4.3) y "es la última cuota"
// (§1 Sobrantes-Excedentes) comparten la misma tabla cartera_preventiva_overrides,
// keyed por llave. Un upsert parcial (solo las columnas presentes en el body)
// no pisa lo que ya se hubiera guardado antes (ej. cerrar cartera después de
// haber corregido el valor de cuota).
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const llave = body?.llave as string | undefined;
  if (!llave) {
    return NextResponse.json({ error: "llave es requerida" }, { status: 400 });
  }

  const update: Record<string, unknown> = { llave };
  if (typeof body?.cerrado_manual === "boolean")        update.cerrado_manual = body.cerrado_manual;
  if (typeof body?.fecha_pago_manual === "string")      update.fecha_pago_manual = body.fecha_pago_manual;
  if (typeof body?.valor_pago_manual === "number")      update.valor_pago_manual = body.valor_pago_manual;
  if (typeof body?.medio_pago_manual === "string")      update.medio_pago_manual = body.medio_pago_manual;
  if (typeof body?.valor_cuota_manual === "number")     update.valor_cuota_manual = body.valor_cuota_manual;
  if (typeof body?.es_ultima_cuota === "boolean")       update.es_ultima_cuota = body.es_ultima_cuota;

  if (Object.keys(update).length === 1) {
    return NextResponse.json({ error: "No hay campos para actualizar" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("cartera_preventiva_overrides")
    .upsert(update, { onConflict: "llave" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "update",
    filters: { ...update, view: "cartera_preventiva_overrides" },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
