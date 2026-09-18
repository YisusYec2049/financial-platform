import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Documento y correo editables (§2.3 consolidado / §3.3 excepciones): corrigen
// identification y/o email de una transacción puntual (ej. NIT sin dígito de
// verificación) y dejan constancia en documento_correcciones.
//
// ⚠️ Los dos campos son INDEPENDIENTES y opcionales: si viene solo uno, se
// escribe solo ese. En Bancolombia y Prebancolombia entran con el mismo valor
// —esos extractos no traen correo, el parser escribe REFERENCIA 1 del PDF en los
// dos campos— pero dejan de ser el mismo dato en cuanto alguien corrige: el
// documento dice QUIÉN ES la persona, el correo dice QUÉ ESCRIBIÓ en el banco.
// Hasta el 18/09/2026 corregir el documento de esas dos fuentes pisaba también
// el correo, y eso le borraba al pipeline el segundo candidato con el que busca
// el CORREO(2) (la hoja de ingresos conoce la referencia que reportó el banco,
// no el documento real): la corrección que el área hacía para arreglar un pago
// era la que le apagaba el cruce por correo. Medido: 14 pagos / $10.023.922 con
// la referencia perdida, 13 de ellos sin CORREO(2).
//
// ⚠️ La corrección vale SOLO para este pago (matching_key_original). Hasta el
// 5 de agosto de 2026 valía "por número" — quedaba la orden de cambiar ese
// documento en cualquier pago, para siempre — y el pipeline la quitó porque
// rompió en producción: le escribió el documento de una persona al pago de
// otra, y la orden vieja seguía pisando el número en cada corrida, así que no
// se podía revertir. Lo que reemplaza esa memoria es la sugerencia que muestran
// las vistas (GET /api/transactions/document-history): se le enseña a la persona
// lo que ya se corrigió antes y ella decide.
//
// El insert deja UNA fila por corrección a propósito: ese historial es lo que
// alimenta la sugerencia. No convertirlo en upsert — se perdería.
//
// 🔴 documento_correcciones se escribe SOLO si cambió el documento: su llave es
// un documento y alimenta la sugerencia por número. Una corrección de correo no
// pertenece ahí, y no hay tabla equivalente para correos (ni se crea acá).
//
// No recalculamos matching_key (esta app no conoce el algoritmo de cada banco)
// — matching_key_nuevo se guarda igual al original porque la llave no cambia,
// solo el documento.
export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey        = body?.matching_key as string | undefined;
  const documentoCorregido = (body?.documento_corregido as string | undefined)?.trim();
  const correoCorregido    = (body?.correo_corregido as string | undefined)?.trim();

  if (!matchingKey || (!documentoCorregido && !correoCorregido)) {
    return NextResponse.json(
      { error: "matching_key y al menos uno de documento_corregido / correo_corregido son requeridos" },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  const { data: tx, error: txError } = await supabase
    .from("consolidated_transactions")
    .select("identification, email")
    .eq("matching_key", matchingKey)
    .maybeSingle();

  if (txError) return NextResponse.json({ error: txError.message }, { status: 500 });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

  const documentoOriginal = tx.identification;
  const correoOriginal    = tx.email;

  const cambiaDocumento = !!documentoCorregido && documentoCorregido !== documentoOriginal;
  const cambiaCorreo    = !!correoCorregido    && correoCorregido    !== correoOriginal;

  if (!cambiaDocumento && !cambiaCorreo) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  const cambios: { identification?: string; email?: string } = {};
  if (cambiaDocumento) cambios.identification = documentoCorregido;
  if (cambiaCorreo)    cambios.email          = correoCorregido;

  const { error: updateTxError } = await supabase
    .from("consolidated_transactions")
    .update(cambios)
    .eq("matching_key", matchingKey);
  if (updateTxError) return NextResponse.json({ error: updateTxError.message }, { status: 500 });

  // NO tocar cruce_cartera.identification: matching-test compara el documento
  // guardado ahí contra el de consolidated_transactions para detectar que alguien
  // corrigió y hay que volver a buscar el cruce. Si lo sobrescribimos aquí, se
  // borra esa señal y las correcciones sobre pagos ya cerrados no hacen nada.
  // Consecuencia esperada: la tab Excepciones sigue mostrando el documento viejo
  // hasta que el pipeline reprocese la fila.

  if (cambiaDocumento) {
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
  }

  logAudit({
    user_email: user.email ?? "unknown",
    // Se distinguen para poder leer la bitácora: una corrección de solo correo
    // no deja fila en documento_correcciones, así que sin esto no habría rastro
    // de qué clase de corrección fue.
    action: cambiaDocumento ? "correct_document" : "correct_email",
    filters: {
      matching_key: matchingKey,
      ...(cambiaDocumento
        ? { documento_original: documentoOriginal, documento_corregido: documentoCorregido }
        : {}),
      ...(cambiaCorreo ? { correo_original: correoOriginal, correo_corregido: correoCorregido } : {}),
    },
    result_count: 1,
  });

  return NextResponse.json({
    success: true,
    ...(cambiaDocumento ? { documento_corregido: documentoCorregido } : {}),
    ...(cambiaCorreo ? { correo_corregido: correoCorregido } : {}),
  });
}
