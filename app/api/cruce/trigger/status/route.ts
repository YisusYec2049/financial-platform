import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

const STATUS_URL = "https://srv1778161.tail6b87a9.ts.net/trigger/cruce/status";

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
    return NextResponse.json({ error: "No se pudo contactar el servicio de actualización" }, { status: 502 });
  }
}
