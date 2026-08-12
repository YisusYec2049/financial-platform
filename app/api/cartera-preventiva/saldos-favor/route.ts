import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { fetchSellados } from "@/lib/sellados";

// Regla #4/#7 (Spec Auto Cartera): saldos a favor vigentes (no auto-aplicados),
// agrupables en el frontend por documento+correo para decidir en qué filas de
// Cartera Preventiva mostrar "Esta inscripción tiene un saldo a favor de $X" +
// botón Asociar. Tabla chica (ledger de sobrantes/descartes), un solo select
// sin paginar alcanza — mismo criterio que overrides/multi-inscripcion.
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("cartera_saldos_favor")
    .select("id, documento, correo, cliente, inscrip, llave_origen, matching_key, monto, disponible, fecha, origen")
    .eq("aplicado", false)
    .gt("disponible", 0);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Tercera parte de la regla del sello (5 de agosto): un pago sellado tampoco
  // aparece como saldo a favor. Hoy son 0 filas, así que en pantalla no cambia
  // nada — se implementa porque la regla lo dice y porque el día que aparezca una,
  // nadie va a estar mirando. Un saldo sin matching_key no se toca (no hay pago
  // que consultar), y la ausencia en cruce_cartera nunca es sello (ver lib/sellados).
  const { sellados, error: selError } = await fetchSellados(supabase, (data || []).map((s) => s.matching_key));
  if (selError) return NextResponse.json({ error: selError }, { status: 500 });

  const vigentes = (data || []).filter((s) => !s.matching_key || !sellados.has(s.matching_key));

  return NextResponse.json({ data: vigentes });
}
