import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const TIPOS_MARCABLES = ["matricula", "cesantias", "otros"] as const;

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey  = body?.matching_key as string | undefined;
  const tipo         = body?.tipo as string | undefined;
  const esPagoUnico  = body?.es_pago_unico === true;
  const nota         = typeof body?.nota === "string" ? body.nota.trim().slice(0, 500) : null;

  if (!matchingKey || !tipo || !TIPOS_MARCABLES.includes(tipo as (typeof TIPOS_MARCABLES)[number])) {
    return NextResponse.json({ error: "matching_key y tipo (matricula|cesantias|otros) son requeridos" }, { status: 400 });
  }
  // Regla #1 (Spec Auto Cartera): "Otros" siempre necesita un motivo, a
  // diferencia de matrícula/cesantías que no lo piden.
  if (tipo === "otros" && !nota) {
    return NextResponse.json({ error: "El motivo es requerido para apartar como \"Otros\"" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: tx, error: txError } = await supabase
    .from("consolidated_transactions")
    .select("*")
    .eq("matching_key", matchingKey)
    .maybeSingle();

  if (txError) return NextResponse.json({ error: txError.message }, { status: 500 });
  if (!tx) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });

  const today = new Date().toISOString().slice(0, 10);

  const { error: upsertError } = await supabase
    .from("pagos_apartados")
    .upsert({
      matching_key: matchingKey,
      tipo,
      origen: "manual",
      es_pago_unico: tipo === "matricula" ? esPagoUnico : false,
      fecha_marcada: today,
      fecha_ingreso: tx.registration_date,
      val: null,
      identification: tx.identification,
      payment_date: tx.payment_date,
      transaction_code_1: tx.transaction_code_1,
      transaction_code_2: tx.transaction_code_2,
      email: tx.email,
      payment_method: tx.payment_method,
      program: tx.program,
      phone: tx.phone,
      payment_amount: tx.payment_amount,
      nota,
    }, { onConflict: "matching_key" });

  if (upsertError) return NextResponse.json({ error: upsertError.message }, { status: 500 });

  // Aprendizaje de cesantías (§2.2): a futuro, cualquier transacción con esta
  // misma descripción exacta se marca sola. No falla la marca si esto falla.
  if (tipo === "cesantias" && tx.transaction_code_1) {
    const { data: existingPattern } = await supabase
      .from("cesantias_patrones")
      .select("descripcion")
      .eq("descripcion", tx.transaction_code_1)
      .maybeSingle();
    if (!existingPattern) {
      await supabase.from("cesantias_patrones").insert({ descripcion: tx.transaction_code_1 });
    }
  }

  logAudit({
    user_email: user.email ?? "unknown",
    action: "mark_apartado",
    filters: { matching_key: matchingKey, tipo, es_pago_unico: esPagoUnico, nota },
    result_count: 1,
  });

  return NextResponse.json({ success: true });
}
