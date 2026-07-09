import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const identification = searchParams.get("identification")?.slice(0, 100) || "";

  if (!identification) {
    return NextResponse.json({ error: "identification es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const [{ data: inscripciones, error: inscripcionesError }, { data: exclusiones, error: exclusionesError }] =
    await Promise.all([
      supabase.from("cartera_inscrip").select("id_inscripcion").eq("numero_id", identification),
      supabase.from("cruce_incp_exclusiones").select("id_inscripcion_excluido").eq("identification", identification),
    ]);

  if (inscripcionesError) return NextResponse.json({ error: inscripcionesError.message }, { status: 500 });
  if (exclusionesError) return NextResponse.json({ error: exclusionesError.message }, { status: 500 });

  const excludedSet = new Set((exclusiones ?? []).map((e) => e.id_inscripcion_excluido));
  const allCandidates = [...new Set((inscripciones ?? []).map((r) => r.id_inscripcion))];
  const candidates = allCandidates.filter((c) => !excludedSet.has(c));

  return NextResponse.json({ candidates, excludedCount: excludedSet.size });
}
