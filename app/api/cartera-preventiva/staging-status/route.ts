import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

// Regla #6 (Spec Auto Cartera): la vista muestra solo la versión activa
// (cartera_preventiva); una cartera nueva subida vive en
// cartera_preventiva_staging hasta que alguien la activa. P1/P2 de la Spec
// Auto Cartera 3 quedaron abiertas sobre el mecanismo exacto de detección —
// se resolvió con el dato disponible hoy: staging solo tiene filas mientras
// hay una carga pendiente sin activar (confirmado con datos reales: staging
// llegó a tener 2618 filas frente a 2604 de la activa el mismo día).
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from("cartera_preventiva_staging")
    .select("id", { count: "exact", head: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ pending: (count ?? 0) > 0, count: count ?? 0 });
}
