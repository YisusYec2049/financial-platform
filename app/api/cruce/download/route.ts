import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";
import { fetchRenglonesCompartidos, expandirRenglones, matchingKeysPorPersona, orMatchingKeys } from "@/lib/pagoCompartido";

export async function GET(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const { searchParams } = new URL(req.url);
  const search        = sanitizeSearch(searchParams.get("search"));
  const paymentMethod = searchParams.get("payment_method")?.slice(0, 100) || "";
  const payFrom       = searchParams.get("pay_from") || "";
  const payTo         = searchParams.get("pay_to") || "";
  const regFrom       = searchParams.get("reg_from") || "";
  const regTo         = searchParams.get("reg_to") || "";
  const sinCrucePreventiva = searchParams.get("sin_cruce_preventiva") === "1";
  const wompiTipo     = searchParams.get("wompi_tipo") || "";

  const supabase = createAdminClient();
  const MAX_ROWS = 50_000;
  const BATCH = 1000;
  let allData: Record<string, unknown>[] = [];
  let from = 0;

  // Misma expansión del buscador que en la lista (ver el comentario allí): la
  // descarga tiene que traer exactamente lo mismo que la pantalla.
  let orPorPersona = "";
  if (search) {
    const { keys, error: keysError } = await matchingKeysPorPersona(supabase, search);
    if (keysError) return NextResponse.json({ error: keysError }, { status: 500 });
    const fragmento = orMatchingKeys(keys);
    if (fragmento) orPorPersona = `,${fragmento}`;
  }

  while (allData.length < MAX_ROWS) {
    const remaining = MAX_ROWS - allData.length;
    const batchSize = Math.min(BATCH, remaining);

    let query = supabase
      .from("cruce_cartera")
      .select("*")
      // Mismo criterio que GET /api/cruce (ver comentario allí): solo cruzadas.
      .eq("estado_cruce", "cruzado")
      .order("payment_date", { ascending: false })
      // Desempate obligatorio (ver comentario en cartera-preventiva/download):
      // sin una columna única al final del orden, el corte entre lotes pierde
      // filas sin error y sin aviso. matching_key es la PK de cruce_cartera.
      .order("matching_key", { ascending: true })
      .range(from, from + batchSize - 1);

    if (search) {
      query = query.or(
        `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%,matching_key.ilike.%${search}%`
        + orPorPersona
      );
    }
    if (paymentMethod) {
      query = paymentMethod.endsWith("%")
        ? query.ilike("payment_method", paymentMethod)
        : query.eq("payment_method", paymentMethod);
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

    if (wompiTipo === "automatico") {
      query = query.not("metodo_de_pago", "is", null).neq("metodo_de_pago", "PAGOS MANUALES");
    } else if (wompiTipo === "manual") {
      query = query.eq("metodo_de_pago", "PAGOS MANUALES");
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    allData = allData.concat(data);
    if (data.length < batchSize) break;
    from += batchSize;
  }

  const truncated = allData.length >= MAX_ROWS;

  const seen = new Set<string>();
  const deduped = allData.filter((row) => {
    const key = row.matching_key as string;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Una fila por RENGLÓN, no por pago: quien abre el Excel tiene que poder sumar la
  // columna del monto y que dé el total real. Con una sola fila por pago compartido
  // esa suma cuenta el pago entero para una persona y a la otra no la ve.
  const pagos = deduped.map((r) => ({
    matching_key: r.matching_key as string,
    identification: (r.identification as string) ?? null,
    payment_amount: r.payment_amount as number | null,
  }));
  const { renglones, error: renglonesError } = await fetchRenglonesCompartidos(supabase, pagos);
  if (renglonesError) return NextResponse.json({ error: renglonesError }, { status: 500 });
  const expandidas = expandirRenglones(deduped, renglones);

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { search, paymentMethod, payFrom, payTo, regFrom, regTo, sinCrucePreventiva, wompiTipo, view: "cruce" },
    result_count: deduped.length,
  });

  // `count` sigue siendo el número de PAGOS (es lo que se compara contra el contador
  // de la pantalla); `renglones` es cuántas filas lleva el archivo.
  return NextResponse.json({
    data: expandidas,
    count: deduped.length,
    renglones: expandidas.length,
    truncated,
  });
}
