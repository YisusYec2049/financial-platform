import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Cierre manual (§4.2) y valor cuota editable (§4.3) comparten la misma tabla
// cartera_preventiva_overrides, keyed por llave. Un upsert parcial (solo las
// columnas presentes en el body) no pisa lo que ya se hubiera guardado antes
// (ej. cerrar cartera después de haber corregido el valor de cuota).
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
