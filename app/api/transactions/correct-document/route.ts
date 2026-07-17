import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Documento editable (§2.3 consolidado / §3.3 excepciones): corrige el campo
// identification de una transacción puntual (ej. NIT sin dígito de
// verificación) y deja constancia POR DOCUMENTO en documento_correcciones,
// para que matching-test corrija sola cualquier transacción futura con el
// mismo documento_original. No recalculamos matching_key (esta app no conoce
// el algoritmo de cada banco) — matching_key_nuevo se guarda igual al
// original porque la llave no cambia, solo el documento.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey      = body?.matching_key as string | undefined;
  const documentoCorregido = (body?.documento_corregido as string | undefined)?.trim();

  if (!matchingKey || !documentoCorregido) {
    return NextResponse.json({ error: "matching_key y documento_corregido son requeridos" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: tx, error: txError } = await supabase
    .from("consolidated_transactions")
    .select("identification")
    .eq("matching_key", matchingKey)
    .maybeSingle();

  if (txError) return NextResponse.json({ error: txError.message }, { status: 500 });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

  const documentoOriginal = tx.identification;
  if (documentoOriginal === documentoCorregido) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  const { error: updateTxError } = await supabase
    .from("consolidated_transactions")
    .update({ identification: documentoCorregido })
    .eq("matching_key", matchingKey);
  if (updateTxError) return NextResponse.json({ error: updateTxError.message }, { status: 500 });

  // Best-effort: si la transacción ya tiene fila en cruce_cartera, corregirla también.
  await supabase
    .from("cruce_cartera")
    .update({ identification: documentoCorregido })
    .eq("matching_key", matchingKey);

  const { error: correccionError } = await supabase
    .from("documento_correcciones")
    .insert({
      documento_original: documentoOriginal,
      documento_corregido: documentoCorregido,
      matching_key_original: matchingKey,
      matching_key_nuevo: matchingKey,
      fecha_correccion: new Date().toISOString().slice(0, 10),
    });
  if (correccionError) return NextResponse.json({ error: correccionError.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "correct_document",
    filters: { matching_key: matchingKey, documento_original: documentoOriginal, documento_corregido: documentoCorregido },
    result_count: 1,
  });

  return NextResponse.json({ success: true, documento_corregido: documentoCorregido });
}
