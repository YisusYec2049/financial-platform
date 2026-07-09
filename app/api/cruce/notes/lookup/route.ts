import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";

const VALID_FUENTES = new Set(["incp", "correo_bc2576", "correo_wompi", "correo_stripe"]);
const MAX_KEYS = 500;

export async function POST(req: NextRequest) {
  const { response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => null);
  const rawKeys: unknown[] = Array.isArray(body?.keys) ? body.keys : [];

  const byFuente = new Map<string, Set<string>>();
  for (const k of rawKeys.slice(0, MAX_KEYS)) {
    const fuente = (k as { fuente?: unknown })?.fuente;
    const claveRaw = (k as { clave?: unknown })?.clave;
    if (typeof fuente !== "string" || !VALID_FUENTES.has(fuente)) continue;
    if (typeof claveRaw !== "string") continue;
    const clave = claveRaw.trim().slice(0, 200);
    if (!clave) continue;
    if (!byFuente.has(fuente)) byFuente.set(fuente, new Set());
    byFuente.get(fuente)!.add(clave);
  }

  if (byFuente.size === 0) return NextResponse.json({ notes: [] });

  const supabase = createAdminClient();
  const results = await Promise.all(
    [...byFuente.entries()].map(([fuente, claves]) =>
      supabase
        .from("cruce_notas_ambiguedad")
        .select("fuente,clave,comentario,actualizado_en")
        .eq("fuente", fuente)
        .in("clave", [...claves])
    )
  );

  const notes = [];
  for (const r of results) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    notes.push(...(r.data ?? []));
  }

  return NextResponse.json({ notes });
}
