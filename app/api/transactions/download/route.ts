import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";
import { categoriaDe, coincideCategoria, etiquetaCategoria, fetchApartados } from "@/lib/apartados";

type Fila = Record<string, unknown>;

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

  const supabase = createAdminClient();

  const MAX_ROWS = 50_000;
  const BATCH = 1000;

  // Los filtros que SÍ puede aplicar la base, en una función: el de categoría se
  // resuelve en JS (ver abajo) y hay que rearmar la consulta una vez por lote.
  const base = () => {
    let q = supabase.from("consolidated_transactions").select("*");

    if (search) {
      q = q.or(
        `identification.ilike.%${search}%,transaction_code_1.ilike.%${search}%,email.ilike.%${search}%,matching_key.ilike.%${search}%`
      );
    }
    if (paymentMethod) {
      q = paymentMethod.endsWith("%")
        ? q.ilike("payment_method", paymentMethod)
        : q.eq("payment_method", paymentMethod);
    }
    if (regFrom) q = q.gte("registration_date", regFrom);
    if (regTo)   q = q.lte("registration_date", regTo);
    if (payFrom) q = q.gte("payment_date", payFrom);
    if (payTo)   q = q.lte("payment_date", payTo);

    return q
      .order("registration_date", { ascending: false })
      // Desempate obligatorio (ver cartera-preventiva/download): sin columna única
      // al final del orden, el corte entre lotes pierde filas en silencio. Hoy esta
      // descarga entrega el total exacto, pero por cómo caen los empates, no porque
      // esté sana. `id` es la PK.
      .order("id", { ascending: true });
  };

  // El mapa de apartados va paginado (lib/apartados.ts): con el `select` suelto
  // esta descarga repetía las dos mentiras de la pantalla — apartados contados
  // como normales, y la lista por tipo incompleta. Se pide SIEMPRE, no solo al
  // filtrar, porque ahora el archivo también dice la categoría de cada fila.
  const { apartados, error: errApartados } = await fetchApartados(supabase);
  if (errApartados) return NextResponse.json({ error: errApartados }, { status: 500 });

  let allData: Fila[] = [];

  if (categoria) {
    // 🔴 La condición de categoría NO puede viajar en la URL: se arma con todas las
    // llaves apartadas y el gateway responde "Bad Request" cuando la URL se pasa de
    // largo (medido el 8/10/2026: el corte está entre 800 y 1.082 llaves, así que
    // hoy ya fallan "Normal" con 1.477 y "Matrícula" con 1.082). Mismo criterio que
    // la lista, para que la descarga no diga otra cosa que la pantalla.
    if (categoria === "normal") {
      for (let from = 0; allData.length < MAX_ROWS; from += BATCH) {
        const { data, error } = await base().range(from, from + BATCH - 1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        for (const row of (data ?? []) as Fila[]) {
          if (!apartados.has(row.matching_key as string)) allData.push(row);
        }
        if (!data || data.length < BATCH) break;
      }
    } else {
      const llaves = [...apartados.entries()]
        .filter(([, a]) => coincideCategoria(categoriaDe(a), categoria))
        .map(([k]) => k);
      // 300 por lote: con 800 ya se roza el tope de URL, y una llave que no entra en
      // la consulta se leería como "este pago no es de esta categoría".
      for (let i = 0; i < llaves.length && allData.length < MAX_ROWS; i += 300) {
        const { data, error } = await base().in("matching_key", llaves.slice(i, i + 300));
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        allData.push(...((data ?? []) as Fila[]));
      }
      // Los lotes vienen ordenados por dentro pero no entre sí. Comparación cruda:
      // `localeCompare` ignora los guiones de los UUID en algunas locales.
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      allData.sort(
        (a, b) =>
          cmp(String(b.registration_date), String(a.registration_date)) ||
          cmp(String(a.id), String(b.id))
      );
    }
    allData = allData.slice(0, MAX_ROWS);
  } else {
    for (let from = 0; allData.length < MAX_ROWS; from += BATCH) {
      const batchSize = Math.min(BATCH, MAX_ROWS - allData.length);
      const { data, error } = await base().range(from, from + batchSize - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data || data.length === 0) break;
      allData = allData.concat(data as Fila[]);
      if (data.length < batchSize) break;
    }
  }

  const truncated = allData.length >= MAX_ROWS;

  const seen = new Set<string>();
  const deduped = allData.filter((row) => {
    const id = row.id as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "download",
    filters: { search, paymentMethod, regFrom, regTo, payFrom, payTo, categoria },
    result_count: deduped.length,
  });

  // La categoría va EN EL ARCHIVO, no solo en el filtro: hasta hoy se podía bajar
  // "solo los certificados" y el Excel no decía de qué categoría era ninguna fila
  // (`json_to_sheet` vuelca las filas crudas de la tabla).
  //
  // 🔴 Las dos columnas van AL FINAL. El área tiene fórmulas que apuntan a la
  // LETRA de la columna, no al título (invariante 6.9): meterlas al principio le
  // correría una letra a todo lo de la derecha. Y el CSV arma sus encabezados con
  // `Object.keys(rows[0])`, así que con esto salen en los dos formatos.
  const conCategoria = deduped.map((row) => {
    const a = apartados.get(row.matching_key as string);
    return {
      ...row,
      categoria: etiquetaCategoria(a?.tipo ?? "normal", a?.nota),
      motivo: a?.tipo === "otros" ? (a.nota ?? "") : "",
    };
  });

  return NextResponse.json({ data: conCategoria, count: conCategoria.length, truncated });
}
