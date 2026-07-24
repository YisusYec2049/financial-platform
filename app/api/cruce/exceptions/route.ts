import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search          = searchParams.get("search")?.slice(0, 100) || "";
  const excepcionMotivo = searchParams.get("excepcion_motivo")?.slice(0, 100) || "";
  const incpCorreo      = searchParams.get("incp_correo")?.slice(0, 100) || "";
  const paymentMethod   = searchParams.get("payment_method")?.slice(0, 100) || "";
  const payFrom         = searchParams.get("pay_from") || "";
  const payTo           = searchParams.get("pay_to") || "";
  const regFrom         = searchParams.get("reg_from") || "";
  const regTo           = searchParams.get("reg_to") || "";
  const page            = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize        = 100;
  const offset          = (page - 1) * pageSize;

  const supabase = createAdminClient();
  let query = supabase
    .from("cruce_cartera")
    .select("*", { count: "exact" })
    // Pendientes + TODOS los no_identificable, sin distinguir banco: un pago que
    // no se logra identificar vive aquí y no sale (spec 23/07 §4). Antes los de
    // WOMPI se iban a la tab "Todas" porque el pipeline los cerraba solo; ya no
    // lo hace, y los 24 que hay están todos marcados a mano.
    .or("estado_cruce.eq.pendiente,estado_cruce.eq.no_identificable")
    .not("excepcion_motivo", "is", null);

  if (search) {
    query = query.or(
      `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%`
    );
  }

  // Valor especial del dropdown: no es un excepcion_motivo, filtra por estado.
  if (excepcionMotivo === "no_identificable") {
    query = query.eq("estado_cruce", "no_identificable");
  } else if (excepcionMotivo) {
    query = query.eq("excepcion_motivo", excepcionMotivo);
  }

  if (incpCorreo) {
    query = query.or(`incp.ilike.%${incpCorreo}%,correo_2.ilike.%${incpCorreo}%`);
  }

  if (paymentMethod) {
    if (paymentMethod.endsWith("%")) {
      query = query.ilike("payment_method", paymentMethod);
    } else {
      query = query.eq("payment_method", paymentMethod);
    }
  }

  if (payFrom) query = query.gte("payment_date", payFrom);
  if (payTo)   query = query.lte("payment_date", payTo);
  if (regFrom) query = query.gte("registration_date", regFrom);
  if (regTo)   query = query.lte("registration_date", regTo);

  query = query
    .order("payment_date", { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, excepcionMotivo, incpCorreo, paymentMethod, payFrom, payTo, regFrom, regTo, page, view: "cruce_excepciones" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}

export async function PATCH(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const matchingKey     = body?.matching_key as string | undefined;
  const noIdentificable = body?.no_identificable === true;
  const incp            = typeof body?.incp === "string" ? body.incp : null;
  const correo2         = typeof body?.correo_2 === "string" ? body.correo_2 : null;
  const nombre          = typeof body?.nombre === "string" ? body.nombre : null;
  const metodoDePago    = typeof body?.metodo_de_pago === "string" ? body.metodo_de_pago : null;
  const ci              = typeof body?.ci === "string" ? body.ci : null;

  if (!matchingKey) {
    return NextResponse.json({ error: "matching_key es requerido" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const update = noIdentificable
    ? { estado_cruce: "no_identificable", corregido_manual: true, corregido_manual_at: now }
    : { incp, correo_2: correo2, nombre, metodo_de_pago: metodoDePago, ci, estado_cruce: "cruzado", corregido_manual: true, corregido_manual_at: now };

  const supabase = createAdminClient();
  const { error, data } = await supabase
    .from("cruce_cartera")
    .update(update)
    .eq("matching_key", matchingKey)
    .select("matching_key");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "update",
    filters: { matching_key: matchingKey, no_identificable: noIdentificable },
    result_count: data?.length ?? 0,
  });

  return NextResponse.json({ success: true });
}
