import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { fetchMotivos, huellaMotivo, normalizarMotivo } from "@/lib/apartados";

/**
 * El catálogo de motivos de "Otros": lo que se elige al apartar un pago, y lo
 * que llena el filtro de categoría en las dos pantallas.
 *
 * GET  → la lista (catálogo + los que ya están en uso), con cuántos pagos tiene
 *        cada uno, el más usado primero.
 * POST → crea uno nuevo. 🔴 Si ya existe uno con la misma huella (sin tildes ni
 *        puntuación) NO se crea otro: se devuelve el que existe. Es lo que evita
 *        volver al problema del campo libre, donde "Certificado" entró de NUEVE
 *        formas y el filtro no servía para nada.
 */
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const { motivos, error } = await fetchMotivos(supabase);
  if (error) return NextResponse.json({ error }, { status: 500 });

  return NextResponse.json({ data: motivos });
}

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const crudo = typeof body?.nombre === "string" ? body.nombre : "";
  const nombre = normalizarMotivo(crudo).slice(0, 60);

  if (!nombre) return NextResponse.json({ error: "El nombre del motivo es requerido" }, { status: 400 });

  const supabase = createAdminClient();
  const { motivos, catalogoDisponible, error } = await fetchMotivos(supabase);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!catalogoDisponible) {
    return NextResponse.json(
      { error: "Falta correr sql/001_apartados_motivos.sql para poder guardar motivos" },
      { status: 503 },
    );
  }

  // Ya existe con otra ortografía → se reusa ese, y se dice cuál.
  const huella = huellaMotivo(nombre);
  const existente = motivos.find((m) => huellaMotivo(m.nombre) === huella);
  if (existente) {
    // Puede estar en uso y fuera del catálogo (una nota vieja): se sube al
    // catálogo, que es lo que lo vuelve elegible de aquí en adelante.
    if (!existente.enCatalogo) {
      const { error: errUp } = await supabase
        .from("apartados_motivos")
        .upsert({ nombre: existente.nombre, activo: true, created_by: user.email ?? "unknown" }, { onConflict: "nombre" });
      if (errUp) return NextResponse.json({ error: errUp.message }, { status: 500 });
    }
    return NextResponse.json({ data: { nombre: existente.nombre }, yaExistia: true });
  }

  const { error: errIns } = await supabase
    .from("apartados_motivos")
    .insert({ nombre, activo: true, created_by: user.email ?? "unknown" });
  if (errIns) return NextResponse.json({ error: errIns.message }, { status: 500 });

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "crear_motivo_apartado",
    filters: { nombre },
    result_count: 1,
  });

  return NextResponse.json({ data: { nombre }, yaExistia: false });
}
