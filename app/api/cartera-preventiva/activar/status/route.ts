import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

// §3: "Cargar Cartera" es caso aparte — no es una fila, es cambiar la cartera
// entera. El aviso tiene que esperar a que el swap de versión TERMINE de verdad
// (antes el banner se quedaba pegado en "Actualizando la vista…" aunque ya hubiera
// acabado). Mismo patrón de proxy que /api/cruce/trigger/status.
const STATUS_URL = "https://srv1778161.tail6b87a9.ts.net/trigger/cartera/activar/status";

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  try {
    const res  = await fetch(STATUS_URL, {
      headers: { Authorization: `Bearer ${process.env.TRIGGER_TOKEN}` },
      cache: "no-store",
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json({ error: json?.error || "No se pudo obtener el estado" }, { status: res.status });
    }

    return NextResponse.json(json);
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el servicio de activación" }, { status: 502 });
  }
}
