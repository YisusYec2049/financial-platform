"use client";

import { useEffect, useState } from "react";

// Persiste un valor de filtro en sessionStorage: sobrevive a navegar entre
// vistas (y a que React desmonte/remonte el componente), pero se limpia solo
// al cerrar la pestaña del navegador.
export function useSessionState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.sessionStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Modo privado / cuota excedida: los filtros no persisten, pero la vista sigue funcionando.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
