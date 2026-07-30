import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";

export async function GET(req: NextRequest) {
  // Autenticación
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search        = sanitizeSearch(searchParams.get("search"));
  const paymentMethod = searchParams.get("payment_method")?.slice(0, 100) || "";
  const regFrom       = searchParams.get("reg_from") || "";
  const regTo         = searchParams.get("reg_to") || "";
  const payFrom       = searchParams.get("pay_from") || "";
  const payTo         = searchParams.get("pay_to") || "";
  const categoria     = searchParams.get("categoria")?.slice(0, 50) || "";
  const page          = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize      = 100;
  const offset        = (page - 1) * pageSize;

  const supabase = createAdminClient();

  // Categoría (§2.4): pagos_apartados es chica (decenas de filas hoy), se trae
  // completa para filtrar por tipo y para anotar la categoría de cada fila de
  // la página sin tener que hacer un join que Postgrest no soporta.
  const { data: apartados } = await supabase.from("pagos_apartados").select("matching_key, tipo");
  const categoriaPorKey = new Map<string, string>();
  for (const a of apartados || []) categoriaPorKey.set(a.matching_key, a.tipo);

  let query = supabase
    .from("consolidated_transactions")
    .select("*", { count: "exact" });

  if (categoria === "normal") {
    const excluidas = [...categoriaPorKey.keys()];
    if (excluidas.length > 0) {
      query = query.not("matching_key", "in", `(${excluidas.map((k) => `"${k}"`).join(",")})`);
    }
  } else if (categoria) {
    const incluidas = [...categoriaPorKey.entries()].filter(([, t]) => t === categoria).map(([k]) => k);
    if (incluidas.length === 0) {
      return NextResponse.json({ data: [], count: 0, page, pageSize });
    }
    query = query.in("matching_key", incluidas);
  }

  if (search) {
    query = query.or(
      `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%,matching_key.ilike.%${search}%`
    );
  }

  if (paymentMethod) {
    if (paymentMethod.endsWith("%")) {
      query = query.ilike("payment_method", paymentMethod);
    } else {
      query = query.eq("payment_method", paymentMethod);
    }
  }

  if (regFrom) query = query.gte("registration_date", regFrom);
  if (regTo)   query = query.lte("registration_date", regTo);
  if (payFrom) query = query.gte("payment_date", payFrom);
  if (payTo)   query = query.lte("payment_date", payTo);

  query = query
    .order("registration_date", { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Alertas visuales (§2.5, no son filtros): documento repetido el mismo día,
  // resaltado aparte si además coincide el monto (posible doble cobro).
  // Se calcula solo sobre las identificaciones presentes en esta página.
  const idsEnPagina = [...new Set((data || []).map((r) => r.identification).filter(Boolean))];
  const gruposPorDocDia = new Map<string, number[]>();
  if (idsEnPagina.length > 0) {
    const { data: relacionados } = await supabase
      .from("consolidated_transactions")
      .select("identification, payment_date, payment_amount")
      .in("identification", idsEnPagina);
    for (const r of relacionados || []) {
      const key = `${r.identification}|${r.payment_date}`;
      if (!gruposPorDocDia.has(key)) gruposPorDocDia.set(key, []);
      gruposPorDocDia.get(key)!.push(r.payment_amount);
    }
  }

  const enriched = (data || []).map((row) => {
    const grupo = gruposPorDocDia.get(`${row.identification}|${row.payment_date}`) || [];
    const documentoRepetido = grupo.length > 1;
    const posibleDobleCobro = documentoRepetido && new Set(grupo).size === 1;
    return {
      ...row,
      categoria: categoriaPorKey.get(row.matching_key) || "normal",
      alerta_documento_repetido: documentoRepetido,
      alerta_posible_doble_cobro: posibleDobleCobro,
    };
  });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, paymentMethod, regFrom, regTo, payFrom, payTo, categoria, page },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data: enriched, count, page, pageSize });
}
