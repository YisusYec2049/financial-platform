import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Regla #6 (Spec Auto Cartera): mismo patrón que /api/cruce/trigger — proxy
// server-side al endpoint HTTP del VPS (protegido por TRIGGER_TOKEN, nunca
// expuesto al cliente) que hace el swap de versión: la staging pasa a activa,
// la anterior se archiva. Irreversible desde la UI — las verificaciones se
// hacen antes de llamar a este endpoint, no después.
const ACTIVAR_URL = "https://srv1778161.tail6b87a9.ts.net/trigger/cartera/activar";

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  try {
    const res  = await fetch(ACTIVAR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TRIGGER_TOKEN}` },
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json({ error: json?.error || "No se pudo activar la cartera nueva" }, { status: res.status });
    }

    logAudit({
      user_email: user!.email ?? "unknown",
      action: "activar_cartera",
    });

    return NextResponse.json(json ?? { success: true });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el servicio de activación" }, { status: 502 });
  }
}
