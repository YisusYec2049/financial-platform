import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

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

  return NextResponse.json({ data: data || [] });
}
