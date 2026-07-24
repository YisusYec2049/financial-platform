import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search        = searchParams.get("search")?.slice(0, 100) || "";
  const paymentMethod = searchParams.get("payment_method")?.slice(0, 100) || "";
  const payFrom       = searchParams.get("pay_from") || "";
  const payTo         = searchParams.get("pay_to") || "";
  const regFrom       = searchParams.get("reg_from") || "";
  const regTo         = searchParams.get("reg_to") || "";
  const sinCrucePreventiva = searchParams.get("sin_cruce_preventiva") === "1";
  const wompiTipo     = searchParams.get("wompi_tipo") || "";
  const page          = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize      = 100;
  const offset        = (page - 1) * pageSize;

  const supabase = createAdminClient();
  let query = supabase
    .from("cruce_cartera")
    .select("*", { count: "exact" })
    // Solo cruzadas. Los no_identificable (de cualquier banco, WOMPI incluido) los
    // marcó una persona a mano y se quedan en la tab Excepciones — el pipeline ya
    // no cierra WOMPI solo, así que no llenan la pantalla y ahí es donde se
    // vuelven a mirar si algún día su documento empieza a cruzar (spec 23/07 §4).
    .eq("estado_cruce", "cruzado");

  if (search) {
    query = query.or(
      `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%`
    );
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

  if (sinCrucePreventiva) {
    query = query
      .eq("estado_cruce", "cruzado")
      .not("incp", "is", null)
      .neq("incp", "")
      .or("cruce.is.null,cruce.eq.");
  }

  // Filtro 2 (spec Wompi-Placetopay): solo se envía cuando el Filtro 1 = "Wompi"
  if (wompiTipo === "automatico") {
    query = query.not("metodo_de_pago", "is", null).neq("metodo_de_pago", "PAGOS MANUALES");
  } else if (wompiTipo === "manual") {
    query = query.eq("metodo_de_pago", "PAGOS MANUALES");
  }

  query = query
    .order("payment_date", { ascending: false })
    .range(offset, offset + pageSize - 1);

  const { data, error, count } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logAudit({
    user_email: user.email ?? "unknown",
    action: "query",
    filters: { search, paymentMethod, payFrom, payTo, regFrom, regTo, sinCrucePreventiva, wompiTipo, page, view: "cruce" },
    result_count: count ?? 0,
  });

  return NextResponse.json({ data, count, page, pageSize });
}
