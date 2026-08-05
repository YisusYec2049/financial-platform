"use client";

import { useMemo } from "react";
import type { CorreccionDoc } from "@/lib/useDocumentHistory";

type Props = {
  matchingKey: string;
  documento: string | null;
  correcciones: CorreccionDoc[];
  /** Rellena el campo de documento con el número sugerido. Sin esto, el aviso B no es clicable. */
  onSugerencia?: (documento: string) => void;
};

function fmtCuando(c: CorreccionDoc): string {
  const iso = c.created_at || c.fecha_correccion;
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Con hora: una corrección de hace un mes y una de hace diez minutos no valen lo mismo.
  return d.toLocaleString("es-CO", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/**
 * Los dos avisos de corrección de documento (spec del 5 de agosto):
 *
 *   A. "Este pago ya se corrigió antes" — para no repetir un número ya descartado
 *      al intentar revertir.
 *   B. "Este número se corrigió antes en otros pagos" — lo que reemplaza la memoria
 *      automática del pipeline, que se quitó porque le pisaba el documento a otra
 *      persona. El número sugerido es clicable y rellena el campo; confirmar sigue
 *      siendo del ✓ de siempre.
 *
 * Nunca se aplica solo, y si no hay nada que mostrar no se muestra nada.
 */
export default function DocumentHistoryHint({ matchingKey, documento, correcciones, onSugerencia }: Props) {
  const doc = (documento || "").trim();

  const { estePago, otrosPagos } = useMemo(() => {
    const estePago = correcciones.filter((c) => c.matching_key_original === matchingKey);
    const otrosPagos = doc
      ? correcciones.filter((c) => c.documento_original === doc && c.matching_key_original !== matchingKey)
      : [];
    return { estePago, otrosPagos };
  }, [correcciones, matchingKey, doc]);

  if (estePago.length === 0 && otrosPagos.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 max-w-[16rem]">
      {estePago.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-600">
          <span className="font-medium text-gray-700">Este pago ya se corrigió:</span>
          <ul className="mt-0.5 space-y-0.5">
            {estePago.map((c, i) => (
              <li key={`a-${i}`} className="whitespace-nowrap">
                {c.documento_original} → <span className="font-medium text-gray-800">{c.documento_corregido}</span>
                <span className="text-gray-400"> · {fmtCuando(c)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {otrosPagos.length > 0 && (
        <div className="rounded-lg border border-brand-200 bg-brand-50 px-2 py-1 text-[11px] text-brand-800">
          <span className="font-medium">Este número ya se corrigió en otro pago:</span>
          <ul className="mt-0.5 space-y-0.5">
            {otrosPagos.map((c, i) => (
              <li key={`b-${i}`} className="whitespace-nowrap">
                {c.documento_original} →{" "}
                {onSugerencia ? (
                  <button
                    type="button"
                    onClick={() => onSugerencia(c.documento_corregido)}
                    title="Usar este número (no se guarda hasta confirmar con ✓)"
                    className="font-semibold underline decoration-dotted underline-offset-2 hover:text-brand-900 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
                  >
                    {c.documento_corregido}
                  </button>
                ) : (
                  <span className="font-semibold">{c.documento_corregido}</span>
                )}
                <span className="text-brand-600/70"> · {fmtCuando(c)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
