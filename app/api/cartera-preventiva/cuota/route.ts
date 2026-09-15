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

  // Se piden TODAS las cuotas de la inscripción de una sola vez: con ellas se
  // contestan las dos preguntas de abajo (¿ya vence una ese día? ¿está tomada la
  // llave?) sin un segundo viaje y sin meter la llave dentro de un patrón `like`,
  // donde los caracteres del lenguaje de filtros de PostgREST entrarían crudos.
  const { data: deLaInscripcion, error: dupErr } = await supabase
    .from("cartera_preventiva")
    .select("llave,cliente,fecha_vencimiento")
    .eq("inscrip", inscrip)
    // Orden por llave para que el aviso nombre siempre la misma fila: la llave de una
    // cuota madre es prefijo de la de su línea de deuda, así que ascendente pone la
    // madre primero — que es la que le sirve a quien lee el mensaje. Sin orden,
    // PostgREST no garantiza cuál de las dos sale, y el aviso cambiaría solo.
    .order("llave", { ascending: true })
    .limit(1000);

  if (dupErr) return NextResponse.json({ error: dupErr.message }, { status: 500 });
  const filasInscrip = deLaInscripcion || [];

  // Validación 1: se pregunta por la FECHA, no por la llave. La llave se congela al
  // nacer la cuota (es con lo que se le amarran el pago aplicado, los overrides y el
  // saldo a favor), así que corregir la fecha de vencimiento mueve la fila y NO la
  // llave: la fecha original le queda ocupada a esa inscripción para siempre, aunque
  // en pantalla ninguna cuota venza ese día. Preguntando por la llave, esta ruta
  // frenaba cuotas legítimas diciendo que ya existía una que vence ese día — y no
  // era cierto. Medido el 14/09: 32 cuotas vivas tienen la llave apuntando a una
  // fecha que ya no es la suya.
  //
  // ⚠️ Nada de `.maybeSingle()`: una cuota partida y su línea de FALTA DE PAGO
  // comparten inscripción y fecha (la línea hereda la fecha de su madre desde el
  // 11/08), así que la consulta devuelve 2 filas y `maybeSingle()` revienta con
  // PGRST116 — el área vería un error de sistema en vez del aviso. Comprobado con
  // `620PN46316` y `620PN46316 (2026-09-10)`, las dos venciendo el 2026-10-21.
  const mismaFecha = filasInscrip.filter((f) => f.fecha_vencimiento === fechaVencimiento);
  if (mismaFecha.length > 0) {
    const otra = mismaFecha[0];
    const quien = otra.cliente ? `, ${otra.cliente}` : "";
    return NextResponse.json({
      // La fecha se nombra desde la FILA ENCONTRADA, no desde lo que se tecleó: el
      // mensaje viejo repetía la entrada y por eso se leía como mentira.
      error: `Ya existe una cuota de ${inscrip} que vence el ${otra.fecha_vencimiento} (llave ${otra.llave}${quien}). No se creó nada.`,
    }, { status: 409 });
  }

  // La fecha está libre pero la llave puede estar tomada por una cuota a la que le
  // corrigieron el vencimiento. Ahí la cuota se crea igual, con la llave marcada.
  //
  // 🔴 El sufijo va con GUION y nunca como " (algo)". El pipeline
  // (`cruzar_cartera_preventiva.py`, `_sincronizar_lineas_falta_de_pago`) y esta
  // misma app (`app/api/cartera-preventiva/route.ts`, `baseDeLlave`) reconocen una
  // línea de deuda partiendo la llave por " (": una cuota nueva llamada
  // "6500PN46332 (2026-11-06)" nacería adoptada como línea de deuda de la vieja —
  // sin botón "Asociar" mientras la madre siga abierta, con el valor reescrito por
  // el pipeline, y candidata a que la borre cuando la madre cierre. Un "-2" no
  // contiene " (" y ninguno de los dos lo mira.
  const tomadas = new Set(filasInscrip.map((f) => f.llave as string));
  let llaveFinal = llave;
  let sufijo = 2;
  while (tomadas.has(llaveFinal)) {
    llaveFinal = `${llave}-${sufijo}`;
    sufijo++;
  }

  const fila = {
    llave: llaveFinal,
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

  return NextResponse.json({ success: true, llave: llaveFinal });
}
