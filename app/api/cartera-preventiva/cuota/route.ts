import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// "Agregar cuota" (spec 23/07 §1) — a veces una cuota que debería estar en la
// cartera no viene en el Excel, y sin cuota el pago de esa persona no tiene dónde
// caer. El pago no se pierde: si un documento no tiene ninguna cuota pendiente el
// pipeline lo salta sin escribir nada y sigue elegible en cada corrida, así que
// basta crear la cuota y reprocesar para que caiga solo.
//
// No hace falta ninguna columna nueva ni tocar el pipeline: el cruce recoge
// cualquier cuota pendiente que encuentre, venga del Excel o no.

// La llave del Excel = inscrip + serial de fecha (días desde 1899-12-30). Usar la
// misma fórmula hace que, si esa cuota aparece luego en una carga nueva, la llave
// coincida y no se duplique. Verificado contra 391/391 filas de origen Excel.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function excelSerial(fecha: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const [y, m, d] = fecha.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) - EXCEL_EPOCH;
  return Math.round(ms / 86_400_000);
}

// Alimenta el formulario: las inscripciones que ya están en cartera para ese
// documento (caso 1, se hereda) y las del Excel de inscripciones (caso 2, la
// inscripción todavía no está en cartera). cartera_inscrip es la misma tabla
// contra la que el pipeline calcula el INCP de cada pago, así que elegir de ahí
// garantiza que la cuota "escuche" al pago.
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const documento = searchParams.get("documento")?.trim().slice(0, 50) || "";
  if (!documento) {
    return NextResponse.json({ error: "documento es requerido" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const [enCartera, enExcel] = await Promise.all([
    supabase
      .from("cartera_preventiva")
      .select("inscrip,cliente,programa,correo,moneda,sistema_financiero")
      .eq("cruce_access", documento)
      .limit(1000),
    supabase
      .from("cartera_inscrip")
      .select("id_inscripcion")
      .eq("numero_id", documento)
      .limit(100),
  ]);

  if (enCartera.error) return NextResponse.json({ error: enCartera.error.message }, { status: 500 });
  if (enExcel.error)   return NextResponse.json({ error: enExcel.error.message }, { status: 500 });

  const filas = enCartera.data || [];
  const inscripciones = new Set<string>();
  for (const f of filas) if (f.inscrip) inscripciones.add(f.inscrip as string);
  for (const f of enExcel.data || []) if (f.id_inscripcion) inscripciones.add(f.id_inscripcion as string);

  // Descriptivos para prellenar: la primera fila del documento que los tenga.
  const primera = filas[0] || null;

  return NextResponse.json({
    inscripciones: [...inscripciones].sort(),
    en_cartera: [...new Set(filas.map((f) => f.inscrip).filter(Boolean))],
    prefill: primera
      ? {
          cliente: primera.cliente ?? "",
          programa: primera.programa ?? "",
          correo: primera.correo ?? "",
          moneda: primera.moneda ?? "COP",
          sistema_financiero: primera.sistema_financiero ?? "",
        }
      : null,
  });
}

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const inscrip          = typeof body?.inscrip === "string" ? body.inscrip.trim() : "";
  const cruceAccess      = typeof body?.cruce_access === "string" ? body.cruce_access.trim() : "";
  const fechaVencimiento = typeof body?.fecha_vencimiento === "string" ? body.fecha_vencimiento.trim() : "";
  const valorCuota       = Number(body?.valor_cuota);

  if (!inscrip)          return NextResponse.json({ error: "La inscripción (INCP) es requerida" }, { status: 400 });
  if (!cruceAccess)      return NextResponse.json({ error: "El documento es requerido" }, { status: 400 });

  const serial = excelSerial(fechaVencimiento);
  if (serial === null)   return NextResponse.json({ error: "La fecha de vencimiento no es válida" }, { status: 400 });

  // Validación 2: sin valor la cascada de cobro la ignora en silencio.
  if (!Number.isFinite(valorCuota) || valorCuota <= 0) {
    return NextResponse.json({ error: "El valor de la cuota debe ser mayor que cero" }, { status: 400 });
  }

  const llave = `${inscrip}${serial}`;
  const supabase = createAdminClient();

  // Validación 1: la llave tiene índice único — un upsert PISARÍA la cuota que ya
  // existe, así que se avisa y no se guarda.
  const { data: existente, error: dupErr } = await supabase
    .from("cartera_preventiva")
    .select("llave,cliente,fecha_vencimiento,valor_cuota")
    .eq("llave", llave)
    .maybeSingle();

  if (dupErr) return NextResponse.json({ error: dupErr.message }, { status: 500 });
  if (existente) {
    return NextResponse.json({
      error: `Ya existe una cuota para ${inscrip} con vencimiento ${fechaVencimiento} (llave ${llave}). No se creó nada.`,
    }, { status: 409 });
  }

  const fila = {
    llave,
    inscrip,
    cruce_access: cruceAccess,
    fecha_vencimiento: fechaVencimiento,
    valor_cuota: valorCuota,
    // Sin abonos previos: el invariante valor_a_cobrar = valor_cuota - pago con pago vacío.
    valor_a_cobrar: valorCuota,
    cliente: typeof body?.cliente === "string" ? body.cliente.trim() : "",
    programa: typeof body?.programa === "string" ? body.programa.trim() : "",
    correo: typeof body?.correo === "string" ? body.correo.trim() : "",
    moneda: typeof body?.moneda === "string" && body.moneda.trim() ? body.moneda.trim() : "COP",
    sistema_financiero: typeof body?.sistema_financiero === "string" && body.sistema_financiero.trim()
      ? body.sistema_financiero.trim()
      : "SIST_F_NUEVO",
    // Todo lo demás queda NULL a propósito (fecha_pago, valor_pago, diferencia,
    // notificacion, fecha_cruce, pago, pago_confirmado): la fila nace con el badge
    // "Sin pago identificado" y es el pipeline quien la resuelve.
  };

  const { error } = await supabase.from("cartera_preventiva").insert(fila);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "insert",
    filters: { ...fila, view: "cartera_preventiva_cuota_manual" },
    result_count: 1,
  });

  return NextResponse.json({ success: true, llave });
}
