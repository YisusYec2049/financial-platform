"use client";

import { useEffect, useState } from "react";

// Persiste un valor de filtro en sessionStorage: sobrevive a navegar entre
// vistas (y a que React desmonte/remonte el componente), pero se limpia solo
// al cerrar la pestaña del navegador.
//
// El estado inicial es siempre `initial` (igual que lo que renderiza el
// servidor, que no tiene acceso a sessionStorage) — leerlo directamente en el
// inicializador de useState producía un hydration mismatch en cualquier
// elemento condicionado por el filtro (ej. el botón "Limpiar filtros").
// El valor persistido se carga después de montar, en un efecto aparte.
//
// `hydrated` tiene que ser estado (no un ref): un ref se muta de forma
// síncrona dentro del propio efecto de lectura, así que en el primer commit
// el efecto de escritura (que corre justo después, en el mismo flush) ya lo
// vería en `true` y sobreescribiría sessionStorage con `initial` — pisando
// el valor recién leído antes de que el re-render lo reflejara. Con estado,
// el efecto de escritura del primer commit todavía ve `hydrated = false`
// (la foto de ese render) y no escribe nada hasta el segundo render, cuando
// `value` ya es el valor persistido de verdad.
export function useSessionState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // Modo privado / cuota excedida: se queda con el valor inicial.
    } finally {
      setHydrated(true);
    }
    // Solo debe correr una vez, al montar el componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Modo privado / cuota excedida: los filtros no persisten, pero la vista sigue funcionando.
    }
  }, [key, value, hydrated]);

  return [value, setValue] as const;
}
