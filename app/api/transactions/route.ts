import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";
import { categoriaDe, coincideCategoria, fetchApartados } from "@/lib/apartados";

type Fila = Record<string, unknown>;

/** Comparación cruda, para ordenar igual que Postgres (ver `filasDeCategoria`). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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

  // Categoría (§2.4): se trae la tabla completa para filtrar por tipo y para
  // anotar la categoría de cada fila de la página sin un join que PostgREST no
  // soporta. Paginada dentro del helper: traerla con un `select` suelto cortaba
  // en 1.000 filas sin avisar y los apartados que se caían del corte se pintaban
  // "Normal" (ver lib/apartados.ts).
  const { apartados, error: errApartados } = await fetchApartados(supabase);
  if (errApartados) return NextResponse.json({ error: errApartados }, { status: 500 });

  // Los filtros que SÍ puede aplicar la base, en una sola función: el filtro de
  // categoría se resuelve acá en JS (ver abajo) y necesita rearmar la consulta
  // una vez por lote.
  const base = () => {
    let q = supabase.from("consolidated_transactions").select("*", { count: "exact" });

    if (search) {
      q = q.or(
        `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%,matching_key.ilike.%${search}%`
      );
    }

    if (paymentMethod) {
      if (paymentMethod.endsWith("%")) {
        q = q.ilike("payment_method", paymentMethod);
      } else {
        q = q.eq("payment_method", paymentMethod);
      }
    }

    if (regFrom) q = q.gte("registration_date", regFrom);
    if (regTo)   q = q.lte("registration_date", regTo);
    if (payFrom) q = q.gte("payment_date", payFrom);
    if (payTo)   q = q.lte("payment_date", payTo);

    return q
      .order("registration_date", { ascending: false })
      // Desempate obligatorio (ver GET /api/cruce): sin columna única al final del
      // orden, hay filas que no salen en ninguna página. `id` es la PK.
      .order("id", { ascending: true });
  };

  // 🔴 El filtro de categoría NO puede viajar dentro de la URL. La condición se
  // arma con TODAS las llaves apartadas (hoy 1.477) y el gateway de Supabase
  // responde "Bad Request" cuando la URL se pasa de largo: medido el 8/10/2026, el
  // corte está entre 800 y 1.082 llaves, así que hoy ya fallan los dos filtros
  // grandes — "Normal" (1.477 llaves) y "Matrícula" (1.082) — con un 500 en la
  // pantalla. Por eso la base aplica los demás filtros y el orden, y la categoría
  // se cruza contra el mapa en memoria:
  //   · un tipo concreto → se piden solo las filas de sus llaves, en lotes de 300
  //   · "Normal"         → se recorre el resultado completo y se descartan las
  //                        apartadas (hoy 7.821 filas, 8 peticiones)
  // La salida limpia es una VISTA SQL con el tipo pegado por `left join`, y es otra
  // spec; hasta entonces esto es lo que evita que el filtro mienta o reviente.
  const filasDeCategoria = async (): Promise<{ filas: Fila[]; error: string | null }> => {
    const filas: Fila[] = [];

    if (categoria === "normal") {
      const BATCH = 1000;
      for (let from = 0; ; from += BATCH) {
        const { data, error } = await base().range(from, from + BATCH - 1);
        if (error) return { filas, error: error.message };
        for (const row of (data ?? []) as Fila[]) {
          if (!apartados.has(row.matching_key as string)) filas.push(row);
        }
        if (!data || data.length < BATCH) break;
      }
      return { filas, error: null };
    }

    const llaves = [...apartados.entries()]
      .filter(([, a]) => coincideCategoria(categoriaDe(a), categoria))
      .map(([k]) => k);
    // 300 llaves por lote: con 800 ya se roza el tope de URL del gateway, y una
    // llave que no entra en la consulta se leería como "este pago no es de esta
    // categoría" — justo al revés de lo que hay que mostrar.
    for (let i = 0; i < llaves.length; i += 300) {
      const { data, error } = await base().in("matching_key", llaves.slice(i, i + 300));
      if (error) return { filas, error: error.message };
      filas.push(...((data ?? []) as Fila[]));
    }
    // Los lotes vienen ordenados por dentro pero no entre sí. Se reordena con el
    // MISMO criterio de la base, y con comparación cruda: `localeCompare` ignora
    // los guiones de los UUID en algunas locales y el desempate dejaría de ser el
    // de Postgres.
    filas.sort(
      (a, b) =>
        cmp(String(b.registration_date), String(a.registration_date)) ||
        cmp(String(a.id), String(b.id))
    );
    return { filas, error: null };
  };

  let data: Fila[] | null = null;
  let count: number | null = null;
  let errorMsg: string | null = null;

  if (categoria) {
    const { filas, error } = await filasDeCategoria();
    if (error) errorMsg = error;
    else {
      data = filas.slice(offset, offset + pageSize);
      count = filas.length;
    }
  } else {
    const res = await base().range(offset, offset + pageSize - 1);
    data = (res.data ?? null) as Fila[] | null;
    count = res.count ?? null;
    errorMsg = res.error?.message ?? null;
  }

  if (errorMsg) return NextResponse.json({ error: errorMsg }, { status: 500 });

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
    const apartado = apartados.get(row.matching_key as string);
    return {
      ...row,
      categoria: apartado?.tipo ?? "normal",
      // El motivo viaja aparte del tipo: la pantalla pinta "Otros · Certificado"
      // y el badge sigue saliendo del tipo, como siempre.
      motivo: apartado?.tipo === "otros" ? apartado.nota : null,
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
