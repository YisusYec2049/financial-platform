import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Al desmarcar una cesantía marcada por error, el spec ofrece también quitar
// el patrón aprendido (§2.2) — de lo contrario transacciones futuras con esa
// misma descripción seguirían marcándose solas.
export async function DELETE(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const descripcion = searchParams.get("descripcion");

  if (!descripcion) {
    return NextResponse.json({ error: "descripcion es requerida" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error, data } = await supabase
    .from("cesantias_patrones")
    .delete()
    .eq("descripcion", descripcion)
    .select("descripcion");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "delete",
    filters: { descripcion, view: "cesantias_patrones" },
    result_count: data?.length ?? 0,
  });

  return NextResponse.json({ success: true });
}
