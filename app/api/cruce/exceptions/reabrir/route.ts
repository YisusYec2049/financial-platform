import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// "Identificar": devuelve al trabajo un pago que alguien cerró a mano como
// `no_identificable`. Es la única vía de vuelta desde la pantalla — el pipeline
// solo reabre las cerradas a mano cuando aparece señal nueva Y la fila estaba sin
// ninguna, así que las 16 (de 111) que se cerraron teniendo INCP o Correo(2) no se
// recuperaban más que por SQL o cambiándoles el documento, que puede estar bien.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey = body?.matching_key as string | undefined;

  if (!matchingKey) {
    return NextResponse.json({ error: "matching_key es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();
  // Se escriben SOLO estos tres campos:
  // - `excepcion_motivo` se conserva porque la lista de Excepciones filtra por
  //   `excepcion_motivo is not null`: vaciarlo dejaría la fila fuera de las dos
  //   vistas (no está en Excepciones y tampoco es `cruzado`) — un pago invisible.
  // - `incp` y `correo_2` se conservan porque reabrir devuelve la fila al trabajo,
  //   no borra lo que ya se sabía; en las 16 filas con señal, esa señal es justo
  //   lo que hay que mirar para decidir.
  const { error, data } = await supabase
    .from("cruce_cartera")
    .update({ estado_cruce: "pendiente", corregido_manual: false, corregido_manual_at: null })
    .eq("matching_key", matchingKey)
    .eq("estado_cruce", "no_identificable")
    .select("matching_key");

  if (error) {
    logAudit({
      user_email: user.email ?? "unknown",
      action: "reabrir_no_identificable",
      filters: { matching_key: matchingKey, error: error.message },
      result_count: 0,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // El `.eq("estado_cruce", …)` del update evita reabrir una fila que ya volvió al
  // trabajo (o que nunca se cerró) desde una pantalla vieja: ahí no alcanza ninguna.
  if (!data || data.length === 0) {
    logAudit({
      user_email: user.email ?? "unknown",
      action: "reabrir_no_identificable",
      filters: { matching_key: matchingKey, error: "no estaba en no_identificable" },
      result_count: 0,
    });
    return NextResponse.json(
      { error: "Este pago ya no está marcado como no identificado. Recarga la vista." },
      { status: 409 }
    );
  }

  // Acción propia en la bitácora: hoy queda rastro de quién cerró el pago (el
  // `update` con no_identificable), sin esto no quedaría de quién lo revirtió.
  logAudit({
    user_email: user.email ?? "unknown",
    action: "reabrir_no_identificable",
    filters: { matching_key: matchingKey },
    result_count: data.length,
  });

  return NextResponse.json({ success: true });
}
