import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const VALID_FUENTES = new Set(["incp", "correo_bc2576", "correo_wompi", "correo_stripe"]);

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body       = await req.json().catch(() => null);
  const fuente     = typeof body?.fuente === "string" ? body.fuente : "";
  const clave      = typeof body?.clave === "string" ? body.clave.trim() : "";
  const comentario = typeof body?.comentario === "string" ? body.comentario.trim() : "";

  if (!VALID_FUENTES.has(fuente)) {
    return NextResponse.json({ error: "fuente inválida" }, { status: 400 });
  }
  if (!clave || clave.length > 200) {
    return NextResponse.json({ error: "clave es requerida (máx. 200 caracteres)" }, { status: 400 });
  }
  if (!comentario || comentario.length > 2000) {
    return NextResponse.json({ error: "comentario es requerido (máx. 2000 caracteres)" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("cruce_notas_ambiguedad")
    .upsert(
      { fuente, clave, comentario, actualizado_en: new Date().toISOString() },
      { onConflict: "fuente,clave" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "upsert_nota_ambiguedad",
    filters: { fuente, clave },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
