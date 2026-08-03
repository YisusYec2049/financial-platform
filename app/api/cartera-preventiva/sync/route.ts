import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Solo-sync: corre sync_cartera.py y nada más (~4 s), contra los ~3 min de la
// cadena completa de /trigger/cruce. Alcanza porque la cartera nueva queda en
// staging esperando a "Cargar Cartera", y ese botón sí dispara su reproceso.
// Comparte el carril del pipeline a propósito (sync reemplaza las tablas que
// lee cruzar.py), así que si hay una corrida en curso responde "queued" y el
// polling de /api/cruce/trigger/status la reporta igual que cualquier otra.
const TRIGGER_URL = "https://srv1778161.tail6b87a9.ts.net/trigger/sync";

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  try {
    const res  = await fetch(TRIGGER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TRIGGER_TOKEN}` },
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json({ error: json?.error || "No se pudo iniciar la búsqueda de archivos" }, { status: res.status });
    }

    // Acción propia (no "trigger_cruce"): en la bitácora hay que poder
    // distinguir quién solo buscó archivos de quién recalculó todo.
    logAudit({
      user_email: user!.email ?? "unknown",
      action: "trigger_sync",
    });

    return NextResponse.json(json ?? { success: true });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el servicio de actualización" }, { status: 502 });
  }
}
