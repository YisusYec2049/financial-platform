"use client";

import { useCallback, useState } from "react";

export type CorreccionDoc = {
  documento_original: string;
  documento_corregido: string;
  matching_key_original: string | null;
  fecha_correccion: string | null;
  created_at: string;
};

type FilaConDocumento = { matching_key: string; identification: string | null };

/**
 * Historial de correcciones de documento de la página que se está viendo.
 *
 * El pipeline dejó de recordar las correcciones (una corrección vale solo para
 * el pago en el que se hizo), así que lo que reemplaza esa memoria es mostrarle
 * a la persona lo que ya se corrigió antes y dejar que ella decida. Este hook
 * solo trae el dato; nunca cambia un documento.
 *
 * `cargar` se llama con las filas recién traídas, UNA vez por página — no por
 * fila. Falla en silencio: es un aviso informativo y no debe tumbar la vista.
 */
export function useDocumentHistory() {
  const [correcciones, setCorrecciones] = useState<CorreccionDoc[]>([]);

  const cargar = useCallback(async (rows: FilaConDocumento[]) => {
    const documentos = new Set<string>();
    const pagos      = new Set<string>();
    for (const row of rows) {
      if (row.identification) documentos.add(row.identification);
      if (row.matching_key)   pagos.add(row.matching_key);
    }
    if (documentos.size === 0 && pagos.size === 0) { setCorrecciones([]); return; }

    const params = new URLSearchParams();
    if (documentos.size) params.set("documentos", [...documentos].join(","));
    if (pagos.size)      params.set("pagos", [...pagos].join(","));

    try {
      const res  = await fetch(`/api/transactions/document-history?${params}`);
      const json = await res.json();
      if (!res.ok) return;
      setCorrecciones((json.correcciones || []) as CorreccionDoc[]);
    } catch {
      // Silencioso a propósito.
    }
  }, []);

  return { correcciones, cargarHistorial: cargar };
}
