import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const identification      = typeof body?.identification === "string" ? body.identification.slice(0, 100) : "";
  const idInscripcionExcluido = typeof body?.id_inscripcion_excluido === "string" ? body.id_inscripcion_excluido.slice(0, 100) : "";

  if (!identification || !idInscripcionExcluido) {
    return NextResponse.json({ error: "identification e id_inscripcion_excluido son requeridos" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("cruce_incp_exclusiones")
    .upsert(
      { identification, id_inscripcion_excluido: idInscripcionExcluido },
      { onConflict: "identification,id_inscripcion_excluido", ignoreDuplicates: true }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user!.email ?? "unknown",
    action: "discard_incp_candidate",
    filters: { identification, id_inscripcion_excluido: idInscripcionExcluido },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
