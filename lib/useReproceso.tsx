"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS  = 5000;
/** Margen antes de creerle a un status que todavía no dice "running" (el VPS tarda un instante en marcarlo). */
const GRACE_MS = 10000;
/**
 * Tope duro: si la corrida no termina, se apaga el indicador igual y se refresca.
 * Medido contra el VPS el 2026-07-22: la cadena `cruzar.py` + `cruzar_cartera_preventiva.py`
 * tardó 4m45s con una corrida encolada encima, así que el tope va bien por arriba de eso.
 */
const MAX_MS   = 15 * 60 * 1000;

/**
 * Dispara el reproceso inmediato (`/api/cruce/reproceso`) tras una acción manual y hace polling
 * de `/api/cruce/reproceso/status` hasta que la corrida termina, momento en el que llama a
 * `onDone` para que la vista vuelva a traer sus datos.
 *
 * El POST sigue siendo best-effort (`.catch`) — si el VPS no responde, la acción del usuario no se
 * rompe, solo no hay reproceso. Ver §3 y §4 del "Spec — Reproceso inmediato".
 *
 * Marcado POR FILA (spec 23/07 §3): `fireTrigger(clave)` deja esa fila marcada "recalculando…"
 * mientras la corrida está en curso, y el conjunto se limpia solo al terminar. Sirve para que el
 * cambio se vea al instante sin esperar los 2-5 minutos del recálculo, y para que una fila que
 * por el cambio deja de pertenecer a la pantalla no se esfume de golpe: se queda marcada hasta
 * que el recálculo termina y ahí sí desaparece con el refetch.
 */
export function useReproceso(onDone?: () => void) {
  const [reprocesando, setReprocesando] = useState(false);
  const [recalculando, setRecalculando] = useState<Set<string>>(new Set());

  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const seenRunRef   = useRef(false);
  const onDoneRef    = useRef(onDone);

  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const finish = useCallback(() => {
    stopPolling();
    setReprocesando(false);
    setRecalculando(new Set());
    onDoneRef.current?.();
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    startedAtRef.current = Date.now();
    seenRunRef.current   = false;

    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed > MAX_MS) { finish(); return; }

      try {
        const res  = await fetch("/api/cruce/reproceso/status");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar el estado");

        if (json.status === "running") {
          seenRunRef.current = true;
        } else if (seenRunRef.current || elapsed > GRACE_MS) {
          finish();
        }
      } catch {
        // Sin estado no se puede saber cuándo terminó: se apaga el indicador y se refresca igual.
        finish();
      }
    }, POLL_MS);
  }, [stopPolling, finish]);

  /**
   * Re-enganche al montar: si YA hay un reproceso en curso (se disparó, el usuario navegó a otra
   * vista y volvió), esta vista retoma el seguimiento aunque no haya sido ella la que lo disparó.
   * El estado vive en el servidor (un solo carril), así que basta con preguntar el status.
   *
   * Sin esto, el `useEffect(() => stopPolling)` de arriba corta el polling al desmontar: la corrida
   * sigue en el servidor pero la UI deja de seguirla, y al volver solo se hace el `fetchData` de
   * montaje — si el pipeline todavía no terminó se ve el dato viejo y nada lo actualiza después,
   * así que el cambio "parece" no aplicado.
   *
   * Si al montar ya terminó, no se engancha y no hace falta: el `fetchData` inicial ya trae el dato
   * nuevo. Las píldoras "Recalculando…" por fila NO se restauran (esa info era local y se perdió al
   * desmontar) — vuelve solo el badge global y el auto-refresco.
   */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/cruce/reproceso/status")
      .then((res) => res.json())
      .then((json) => {
        if (cancelled || json?.status !== "running") return;
        setReprocesando(true);
        startPolling();
        // `startPolling` resetea `seenRunRef`, pero acabamos de ver la corrida en vivo: marcarla
        // evita que el primer poll caiga en la ventana de gracia y dé la corrida por terminada.
        seenRunRef.current = true;
      })
      .catch(() => { /* sin status no hay nada que retomar */ });
    return () => { cancelled = true; };
  }, [startPolling]);

  /** `clave` identifica la fila tocada (llave, matching_key, documento…) para marcarla. */
  const fireTrigger = useCallback((clave?: string) => {
    setReprocesando(true);
    if (clave) setRecalculando((prev) => new Set(prev).add(clave));
    fetch("/api/cruce/reproceso", { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error();
        startPolling();
      })
      .catch(() => {
        // Sin reproceso no hay nada que esperar: se quita la marca y se deja el cambio
        // ya guardado tal como está en pantalla (no se refresca, para no pisar la
        // actualización optimista con datos que el pipeline todavía no tocó).
        stopPolling();
        setReprocesando(false);
        setRecalculando(new Set());
      });
  }, [startPolling, stopPolling]);

  const isRecalculando = useCallback((clave: string) => recalculando.has(clave), [recalculando]);

  /** Píldora por fila — se pone junto al cambio que el usuario acaba de hacer. */
  const marcaFila = (clave: string) =>
    recalculando.has(clave) ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200/80 rounded-full px-1.5 py-0.5 whitespace-nowrap">
        <svg className="w-2.5 h-2.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Recalculando…
      </span>
    ) : null;

  const reprocesoBadge = reprocesando ? (
    <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 bg-white/95 backdrop-blur border border-gray-200 shadow-lg rounded-full pl-3 pr-4 py-2 animate-fade-in">
      <svg className="w-3.5 h-3.5 animate-spin text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      <span className="text-xs font-medium text-gray-700">Reprocesando…</span>
    </div>
  ) : null;

  return { fireTrigger, reprocesando, reprocesoBadge, isRecalculando, marcaFila };
}
