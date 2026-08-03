import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const TRIGGER_URL = "https://srv1778161.tail6b87a9.ts.net/trigger/reproceso";

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  // Modo puntual: con un `matching_key`, cruzar.py trae de cada tabla solo lo
  // que ese pago necesita y omite los pases globales (medido 2026-08-02 contra
  // producción: 29 s → 10-12 s). Sin él, el cuerpo va vacío y corre completo,
  // que es el comportamiento correcto para cualquier acción sobre una cuota.
  const body = await req.json().catch(() => ({}));
  const matchingKey = typeof body?.matching_key === "string" ? body.matching_key.trim() : "";

  try {
    const res  = await fetch(TRIGGER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TRIGGER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(matchingKey ? { matching_key: matchingKey } : {}),
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json({ error: json?.error || "No se pudo iniciar el reproceso" }, { status: res.status });
    }

    // Queda en la bitácora si la corrida fue puntual o completa: cuando algo
    // salga raro, esa distinción es lo primero que hay que poder mirar.
    logAudit({
      user_email: user!.email ?? "unknown",
      action: "trigger_reproceso",
      filters: { matching_key: matchingKey || null },
    });

    return NextResponse.json(json ?? { success: true });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el servicio de reproceso" }, { status: 502 });
  }
}
