import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

// Panel de asociación manual (§4.1): solo debe ofrecerse cuando un documento
// (cruce_access) tiene 2+ INSCRIPCIONES DISTINTAS con cuota pendiente — no
// 2+ filas (una sola inscripción normalmente tiene muchas cuotas/filas
// pendientes, eso no es ambigüedad). Verificado con datos reales: contando
// filas salían 127 "documentos", contando inscrip distintos por documento dan
// 29 — el número exacto que cita el spec (ej. doc 1004376520 con 4038PN y
// 40667). Postgrest no soporta GROUP BY/HAVING desde supabase-js, así que se
// trae cruce_access+inscrip de las filas pendientes (~2500 hoy, paginado) y
// se agrupa en JS — volumen chico, no amerita una función RPC dedicada.
//
// Bug reportado por el usuario (2026-07-17): esta condición sola no basta.
// El spec exige AMBAS: 2+ inscripciones distintas Y al menos un pago sin
// asociar. Documentos como el 919207621 (2 inscripciones, 3 cuotas, 0 pagos
// — la persona simplemente debe en 2 programas y nunca pagó) no tienen nada
// que asociar, así que el botón "Asociar" no debe aparecer ahí. Se agrega la
// misma condición que ya usa GET /api/cartera-preventiva/asociar: al menos
// un pago de consolidated_transactions cuyo payment_amount, menos lo ya
// repartido en pago_asociaciones para ese matching_key, sea > 0.
export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const BATCH = 1000;
  let from = 0;
  const porDocumento = new Map<string, Set<string>>();

  while (true) {
    const { data, error } = await supabase
      .from("cartera_preventiva")
      .select("cruce_access, inscrip")
      .is("fecha_pago", null)
      .not("cruce_access", "is", null)
      .neq("cruce_access", "")
      // Sin ORDER BY, Postgres puede devolver las filas como quiera y cambiar de
      // reparto entre un lote y el siguiente: es el caso PEOR de la paginación,
      // porque se pierden filas sin que haya siquiera un empate que lo explique.
      // Y acá duele: este endpoint decide a qué documentos se les ofrece el botón
      // "Asociar", así que una fila perdida es una persona a la que la pantalla no
      // le ofrece asociar su pago, sin decir por qué.
      .order("id", { ascending: true })
      .range(from, from + BATCH - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    for (const row of data) {
      const doc = row.cruce_access as string;
      if (!porDocumento.has(doc)) porDocumento.set(doc, new Set());
      porDocumento.get(doc)!.add(row.inscrip as string);
    }

    if (data.length < BATCH) break;
    from += BATCH;
  }

  const candidatos = [...porDocumento.entries()].filter(([, s]) => s.size >= 2).map(([doc]) => doc);
  if (candidatos.length === 0) return NextResponse.json({ documentos: [] });

  const { data: pagos, error: pagosError } = await supabase
    .from("consolidated_transactions")
    .select("matching_key, identification, payment_amount")
    .in("identification", candidatos);
  if (pagosError) return NextResponse.json({ error: pagosError.message }, { status: 500 });

  const matchingKeys = (pagos || []).map((p) => p.matching_key);
  const asociado = new Map<string, number>();
  if (matchingKeys.length > 0) {
    const { data: asociaciones, error: asocError } = await supabase
      .from("pago_asociaciones")
      .select("matching_key, monto")
      .in("matching_key", matchingKeys);
    if (asocError) return NextResponse.json({ error: asocError.message }, { status: 500 });
    for (const a of asociaciones || []) {
      asociado.set(a.matching_key, (asociado.get(a.matching_key) ?? 0) + Number(a.monto));
    }
  }

  const conPagoSinAsociar = new Set<string>();
  for (const p of pagos || []) {
    const restante = Number(p.payment_amount) - (asociado.get(p.matching_key) ?? 0);
    if (restante > 0) conPagoSinAsociar.add(p.identification);
  }

  const documentos = candidatos.filter((doc) => conPagoSinAsociar.has(doc));

  return NextResponse.json({ documentos });
}
