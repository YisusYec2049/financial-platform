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
 */
export function useReproceso(onDone?: () => void) {
  const [reprocesando, setReprocesando] = useState(false);

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

  const fireTrigger = useCallback(() => {
    setReprocesando(true);
    fetch("/api/cruce/reproceso", { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error();
        startPolling();
      })
      .catch(() => { stopPolling(); setReprocesando(false); });
  }, [startPolling, stopPolling]);

  const reprocesoBadge = reprocesando ? (
    <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 bg-white/95 backdrop-blur border border-gray-200 shadow-lg rounded-full pl-3 pr-4 py-2 animate-fade-in">
      <svg className="w-3.5 h-3.5 animate-spin text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      <span className="text-xs font-medium text-gray-700">Reprocesando…</span>
    </div>
  ) : null;

  return { fireTrigger, reprocesando, reprocesoBadge };
}
