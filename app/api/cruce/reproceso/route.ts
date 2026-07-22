import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const TRIGGER_URL = "https://srv1778161.tail6b87a9.ts.net/trigger/reproceso";

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
      return NextResponse.json({ error: json?.error || "No se pudo iniciar el reproceso" }, { status: res.status });
    }

    logAudit({
      user_email: user!.email ?? "unknown",
      action: "trigger_reproceso",
    });

    return NextResponse.json(json ?? { success: true });
  } catch {
    return NextResponse.json({ error: "No se pudo contactar el servicio de reproceso" }, { status: 502 });
  }
}
