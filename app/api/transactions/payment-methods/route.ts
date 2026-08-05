import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("get_distinct_payment_methods");

  if (error) {
    // Camino de respaldo (hoy dormido: la RPC responde). Se pagina en vez de
    // pedir .limit(100000): PostgREST devuelve como máximo 1.000 filas y NO
    // avisa, así que ese límite leía las primeras 1.000 transacciones y podía
    // dejar un banco entero fuera del dropdown, sin error. Mismo problema que
    // el .limit(5000) de cerrar-dia y que el orden sin desempate del resto de
    // las consultas paginadas (spec 2026-08-05).
    const BATCH = 1000;
    const valores = new Set<string>();
    for (let from = 0; ; from += BATCH) {
      const { data: fallback, error: err2 } = await supabase
        .from("consolidated_transactions")
        .select("payment_method")
        .order("id", { ascending: true })
        .range(from, from + BATCH - 1);

      if (err2) return NextResponse.json({ error: err2.message }, { status: 500 });
      if (!fallback || fallback.length === 0) break;

      for (const r of fallback as { payment_method: string }[]) {
        if (r.payment_method) valores.add(r.payment_method);
      }
      if (fallback.length < BATCH) break;
    }

    return NextResponse.json([...valores].sort());
  }

  const unique = (data as { payment_method: string }[]).map((r) => r.payment_method).sort();
  return NextResponse.json(unique);
}
