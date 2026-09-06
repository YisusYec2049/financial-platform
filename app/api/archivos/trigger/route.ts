import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

/**
 * ⚠️ **La URL va escrita a mano, como las otras 8.** No está en una variable de
 * entorno: así se decidió, y por eso la migración de servidor del 24 de agosto
 * pudo reutilizar el nombre de Tailscale en vez de tocar código. Seguir la
 * convención, no "mejorarla" acá.
 */
const TRIGGER_URL = "https://srv1778161.tail6b87a9.ts.net/trigger/ingesta";

/**
 * Corre la cadena completa sobre lo que haya en el depósito:
 * `sync_cartera.py && procesar_todos.py && cruzar.py && cruzar_cartera_preventiva.py`.
 *
 * 🔴 **Este botón NO sella pagos.** El sello lo pone únicamente la corrida de
 * las 9:30; `/trigger/ingesta` ya está hecho sin `--cierre-diario`. Un botón no
 * puede cerrarle la puerta a un pago, porque el sello no se deshace desde la
 * pantalla. Está anotado acá para que nadie pida "un botón que además cierre el
 * día" (§9.4 de la spec).
 *
 * El estado se consulta con `/api/cruce/trigger/status`: es el mismo carril.
 */
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  try {
    const res = await fetch(TRIGGER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TRIGGER_TOKEN}` },
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return NextResponse.json(
        { error: json?.error || "No se pudo iniciar el procesamiento" },
        { status: res.status }
      );
    }

    logAudit({
      user_email: user!.email ?? "unknown",
      action: "trigger_ingesta",
    });

    return NextResponse.json(json ?? { success: true });
  } catch {
    return NextResponse.json(
      { error: "No se pudo contactar el servicio de procesamiento" },
      { status: 502 }
    );
  }
}
