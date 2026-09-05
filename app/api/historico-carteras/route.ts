import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  parseFiltrosHistorico,
  tablaDeCartera,
  aplicarFiltrosHistorico,
  ordenarHistorico,
} from "@/lib/historicoCarteras";

/**
 * La lista paginada del Histórico de Carteras. SOLO LECTURA — esta sección no escribe
 * nada: esas cuotas ya se archivaron con sus pagos, y "cerrar" o "descartar" sobre una
 * fila archivada sería escribir sobre historia.
 *
 * ⚠️ La misma llave puede aparecer en varias carteras y está bien: la gracia es ver cómo
 * se veía esa cuota en cada momento. NO se deduplica por llave.
 */
export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const filtros  = parseFiltrosHistorico(searchParams);
  const page     = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize = 100;
  const offset   = (page - 1) * pageSize;

  const supabase = createAdminClient();

  const base = supabase
    .from(tablaDeCartera(filtros.cartera))
    .select("*", { count: "exact" });

  const { data, error, count } = await ordenarHistorico(aplicarFiltrosHistorico(base, filtros))
    .range(offset, offset + pageSize - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { ...filtros, page, view: "historico_carteras" },
    result_count: count ?? 0,
  });

  // El total sale del `count` exacto de la base, nunca del largo de la página.
  return NextResponse.json({ data: data || [], count: count ?? 0, page, pageSize });
}
