"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";
import { useReproceso } from "@/lib/useReproceso";
import { parseMonto, formatMonto } from "@/lib/monto";

// Solo pregunta a Drive si llegó cartera nueva: corre sync_cartera.py y nada
// más (~4 s) vía /api/cartera-preventiva/sync. NO recalcula el cruce — eso
// sigue siendo "Actualizar cruce" (/api/cruce/trigger, ~3 min). Vive acá, junto
// al banner de staging, porque es donde se ve el resultado: si el Excel traía
// cartera nueva, queda en staging esperando a "Cargar Cartera" (este botón NO
// activa nada). El polling sigue siendo el de /api/cruce/trigger/status: el
// sync comparte el carril del pipeline, así que se reporta ahí igual.
function BuscarArchivosButton({ onDone }: { onDone: () => Promise<number | null> }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError]     = useState("");
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const antesRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const finish = useCallback(async (exitCode: number, logTail: string) => {
    stopPolling();
    setRunning(false);
    const despues = await onDone();
    if (exitCode !== 0) {
      setError(`La búsqueda terminó con errores${logTail ? `:\n${logTail.slice(-800)}` : "."}`);
      return;
    }
    // Si el conteo de staging no se movió, Drive no traía nada nuevo. Decirlo
    // explícitamente: un botón que termina en silencio es el problema original.
    if (antesRef.current !== null && despues !== null && despues === antesRef.current) {
      setMessage(despues > 0
        ? "No había archivos nuevos en Drive. Sigue pendiente la cartera que ya estaba en staging."
        : "Listo. No había archivos nuevos en Drive.");
    } else if (despues && despues > 0) {
      setMessage(`Listo. Llegó cartera nueva (${despues.toLocaleString("es-CO")} cuotas) — revisa el banner para cargarla.`);
    } else {
      setMessage("Listo.");
    }
  }, [stopPolling, onDone]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch("/api/cruce/trigger/status");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar el estado");
        if (json.status !== "running") await finish(json.exit_code ?? 0, json.log_tail || "");
      } catch (err) {
        stopPolling();
        setRunning(false);
        setError(err instanceof Error ? err.message : "Error inesperado");
      }
    }, 3000);
  }, [stopPolling, finish]);

  // Re-enganche al montar: si ya hay una corrida en curso (la disparó otra
  // persona, u otra pestaña), seguirla en vez de dejar el botón habilitado.
  // El carril del VPS es uno solo, así que puede ser esta cadena o un reproceso.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res  = await fetch("/api/cruce/trigger/status");
        const json = await res.json();
        if (!cancelado && res.ok && json.status === "running") {
          antesRef.current = null;
          setRunning(true);
          setMessage("Hay un proceso en curso, siguiéndolo...");
          startPolling();
        }
      } catch {
        // Sin status no hay nada que retomar: el botón queda utilizable.
      }
    })();
    return () => { cancelado = true; };
  }, [startPolling]);

  const handleClick = async () => {
    setRunning(true);
    setMessage("");
    setError("");
    try {
      antesRef.current = await onDone();
      const statusRes  = await fetch("/api/cruce/trigger/status");
      const statusJson = await statusRes.json();
      if (statusJson.status !== "running") {
        const res  = await fetch("/api/cartera-preventiva/sync", { method: "POST" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "No se pudo iniciar la búsqueda");
      }
      startPolling();
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : "Error inesperado");
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={running}
        title="Revisa si hay cartera nueva en Drive y la deja en espera. No recalcula el cruce ni activa la cartera: eso sigue siendo 'Cargar Cartera'."
        className="flex items-center gap-1.5 bg-emerald-600 text-white text-sm px-3.5 py-1.5 rounded-full shadow-sm hover:bg-emerald-700 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-60"
      >
        <svg className={`w-4 h-4 ${running ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {running ? "Buscando..." : "Buscar archivos nuevos"}
      </button>
      {running && <span className="text-[11px] text-gray-500">Revisando Drive...</span>}
      {message && !running && <span className="text-[11px] text-gray-600 max-w-xs text-right">{message}</span>}
      {error && <span className="text-[11px] text-red-600 max-w-xs text-right whitespace-pre-wrap">{error}</span>}
    </div>
  );
}

type CarteraPreventivaRow = {
  id: number;
  llave: string;
  inscrip: string;
  cliente: string;
  correo: string;
  correo_elec: string | null;
  codigo_transaccion_1: string | null;
  codigo_transaccion_2: string | null;
  fecha_vencimiento: string;
  dias_en_cartera: number;
  valor_cuota: number;
  valor_a_cobrar: number;
  programa: string;
  cruce_access: string;
  sistema_financiero: string | null;
  moneda: string | null;
  telefono_1: string | null;
  telefono_2: string | null;
  pago: string | null;
  fecha_pago: string | null;
  medio_pago: string | null;
  valor_pago: number | null;
  // Solo se llena cuando una persona cierra la cuota (botón "Cerrar Cuota" o
  // "Cerrar Cartera"): distingue una cuota cerrada de una que solo trae un
  // abono del Excel. Es la definición del filtro "Cerradas".
  pago_confirmado: number | null;
  diferencia: number | null;
  fecha_cruce: string | null;
  notificacion: string | null;
  // Cuántas cuotas distintas debe la inscripción de esta fila, sobre TODA la cartera.
  // Lo calcula la vista `cartera_preventiva_v` colapsando los renglones de una misma
  // cuota cobrada por partes ("llave" + "llave (fecha)"). Alimenta el filtro
  // "Inscripciones con varias cuotas".
  cuotas_inscripcion?: number | null;
  // Lo calcula GET /api/cartera-preventiva: esta fila es una "línea de deuda"
  // (llave de otra cuota + sufijo entre paréntesis) y su cuota original sigue
  // abierta. Mientras eso sea cierto la plata se asocia en la original — la
  // línea es solo el reflejo de su `diferencia` y el pipeline la baja solo.
  original_abierta?: boolean;
};

type PagoAsociable = {
  matching_key: string;
  payment_amount: number;
  payment_date: string;
  transaction_code_1: string | null;
  restante: number;
};

type InscripcionPendiente = {
  llave: string;
  inscrip: string;
  cliente: string | null;
  valor_a_cobrar: number;
  valor_cuota: number;
  sistema_financiero: string | null;
  fecha_vencimiento: string;
};

// Lo que se muestra al buscar el documento destino de un envío de saldo. Sale del
// MISMO GET del panel de asociar, que ya devuelve las inscripciones con cuota
// pendiente de un documento — no hizo falta ruta nueva.
type DestinoTraslado = {
  cliente: string | null;
  inscripciones: string[];
  debe: number;
};

// Regla #4/#7 (Spec Auto Cartera): ledger de saldos a favor no auto-aplicados
// (sobrantes y descartes), agrupables por documento+correo.
type SaldoFavorRow = {
  id: number;
  documento: string | null;
  correo: string | null;
  cliente: string | null;
  inscrip: string | null;
  llave_origen: string | null;
  matching_key: string;
  monto: number;
  disponible: number;
  fecha: string | null;
  origen: string | null;
};

// Regla #3: asociación pago↔cuota ya aplicada, candidata a descartar.
type AsociacionRow = {
  id: number;
  matching_key: string;
  monto: number;
  origen: string;
  created_at: string;
  transaction_code_1: string | null;
  payment_date: string | null;
};

// Polling del swap de versión de "Cargar Cartera" (§3). GRACE cubre el instante
// entre el POST y que el VPS marque la corrida como running.
const ACTIVAR_POLL_MS  = 3000;
const ACTIVAR_GRACE_MS = 10000;
const ACTIVAR_MAX_MS   = 5 * 60 * 1000;

export default function CarteraPreventivaView() {
  const [data, setData]                 = useState<CarteraPreventivaRow[]>([]);
  const [total, setTotal]               = useState(0);
  // Solo con el filtro de Diferencia puesto: ahí `total` cuenta CUOTAS y esto cuenta
  // los renglones que se ven (cada cuota arrastra sus líneas derivadas).
  const [renglones, setRenglones]       = useState<number | null>(null);
  const [page, setPage]                 = useState(1);
  const [loading, setLoading]           = useState(false);
  const [search, setSearch]             = useSessionState("cartera_preventiva.search", "");
  const [estado, setEstado]             = useSessionState("cartera_preventiva.estado", "todas");
  const [vencFrom, setVencFrom]         = useSessionState("cartera_preventiva.vencFrom", "");
  const [vencTo, setVencTo]             = useSessionState("cartera_preventiva.vencTo", "");
  const [pagoParcial, setPagoParcial]   = useSessionState("cartera_preventiva.pagoParcial", false);
  const [medioPago, setMedioPago]       = useSessionState("cartera_preventiva.medioPago", "");
  const [wompiTipo, setWompiTipo]       = useSessionState("cartera_preventiva.wompiTipo", "");
  const [payFrom, setPayFrom]           = useSessionState("cartera_preventiva.payFrom", "");
  const [payTo, setPayTo]               = useSessionState("cartera_preventiva.payTo", "");
  const [cruceFrom, setCruceFrom]       = useSessionState("cartera_preventiva.cruceFrom", "");
  const [cruceTo, setCruceTo]           = useSessionState("cartera_preventiva.cruceTo", "");
  const [conNotificacion, setConNotificacion] = useSessionState("cartera_preventiva.conNotificacion", false);
  const [multiCuota, setMultiCuota] = useSessionState("cartera_preventiva.multiCuota", false);
  // "" | "falta" | "sobra" — ver lib/carteraDiferencia.ts
  const [diferencia, setDiferencia] = useSessionState("cartera_preventiva.diferencia", "");
  const [medios, setMedios]             = useState<{ label: string; value: string }[]>([]);
  const [fetchError, setFetchError]     = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [multiInscripcionDocs, setMultiInscripcionDocs] = useState<Set<string>>(new Set());
  const [ultimaCuotaLlaves, setUltimaCuotaLlaves] = useState<Set<string>>(new Set());
  const [asociarOpen, setAsociarOpen]           = useState<Record<string, boolean>>({});
  const [asociarData, setAsociarData]           = useState<Record<string, { inscripciones: InscripcionPendiente[]; pagos: PagoAsociable[] }>>({});
  const [asociarLoading, setAsociarLoading]     = useState<Record<string, boolean>>({});
  const [asociarError, setAsociarError]         = useState<Record<string, string>>({});
  const [asociarMessage, setAsociarMessage]     = useState<Record<string, string>>({});
  const [montoOtroValor, setMontoOtroValor]     = useState<Record<string, string>>({});
  // Envío de saldo a otro documento. Todo va por pago (`${doc}:${matching_key}`),
  // que es la unidad sobre la que se decide: un pago puede cubrir a dos personas.
  const [enviarOpen, setEnviarOpen]             = useState<Record<string, boolean>>({});
  const [enviarDocInput, setEnviarDocInput]     = useState<Record<string, string>>({});
  const [enviarMontoInput, setEnviarMontoInput] = useState<Record<string, string>>({});
  const [enviarDestino, setEnviarDestino]       = useState<Record<string, DestinoTraslado | null>>({});
  const [enviarBuscando, setEnviarBuscando]     = useState<Record<string, boolean>>({});
  const [enviarError, setEnviarError]           = useState<Record<string, string>>({});
  const [cierreOpen, setCierreOpen]             = useState<Record<string, boolean>>({});
  const [cierreFecha, setCierreFecha]           = useState<Record<string, string>>({});
  const [cuotaEdits, setCuotaEdits]             = useState<Record<string, string>>({});
  const [vencEdits, setVencEdits]               = useState<Record<string, string>>({});
  const [pagoEdits, setPagoEdits]               = useState<Record<string, string>>({});
  const [rowSaving, setRowSaving]               = useState<string | null>(null);
  const [rowMessage, setRowMessage]             = useState<Record<string, string>>({});
  const [rowError, setRowError]                 = useState<Record<string, string>>({});
  const [saldosFavor, setSaldosFavor]           = useState<SaldoFavorRow[]>([]);
  const [asociarSaldoOpen, setAsociarSaldoOpen] = useState<Record<string, boolean>>({});
  const [saldoOtroValor, setSaldoOtroValor]     = useState<Record<string, string>>({});
  const [descartarOpen, setDescartarOpen]       = useState<Record<string, boolean>>({});
  const [descartarData, setDescartarData]       = useState<Record<string, AsociacionRow[]>>({});
  const [descartarLoading, setDescartarLoading] = useState<Record<string, boolean>>({});
  const [descartarError, setDescartarError]     = useState<Record<string, string>>({});
  const [stagingCount, setStagingCount]         = useState(0);
  const [activando, setActivando]               = useState(false);
  const [activarMessage, setActivarMessage]     = useState("");
  const [activarError, setActivarError]         = useState("");
  const [agregarOpen, setAgregarOpen]           = useState(false);
  const [agregarForm, setAgregarForm]           = useState({
    cruce_access: "", inscrip: "", fecha_vencimiento: "", valor_cuota: "",
    cliente: "", programa: "", correo: "", moneda: "COP", sistema_financiero: "SIST_F_NUEVO",
  });
  const [agregarInscripciones, setAgregarInscripciones] = useState<string[]>([]);
  const [agregarEnCartera, setAgregarEnCartera] = useState<string[]>([]);
  const [agregarBuscando, setAgregarBuscando]   = useState(false);
  const [agregarGuardando, setAgregarGuardando] = useState(false);
  const [agregarError, setAgregarError]         = useState("");
  const [agregarMessage, setAgregarMessage]     = useState("");
  const [cerrarDiaOpen, setCerrarDiaOpen]       = useState(false);
  const [cerrandoDia, setCerrandoDia]           = useState(false);
  const [cerrarDiaMessage, setCerrarDiaMessage] = useState("");
  const [cerrarDiaError, setCerrarDiaError]     = useState("");
  const searchTimeout                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef              = useRef<AbortController | null>(null);
  const tableContainerRef               = useRef<HTMLDivElement>(null);
  const dropdownRef                     = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 100;

  const fetchData = useCallback(async (currentPage = 1) => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setLoading(true);
    setFetchError("");
    const params = new URLSearchParams();
    if (search)       params.set("search", search);
    if (estado !== "todas") params.set("estado", estado);
    if (vencFrom)     params.set("venc_from", vencFrom);
    if (vencTo)       params.set("venc_to", vencTo);
    if (pagoParcial)  params.set("pago_parcial", "1");
    if (medioPago)    params.set("medio_pago", medioPago);
    if (payFrom)      params.set("pay_from", payFrom);
    if (payTo)        params.set("pay_to", payTo);
    if (cruceFrom)    params.set("cruce_from", cruceFrom);
    if (cruceTo)      params.set("cruce_to", cruceTo);
    if (conNotificacion) params.set("con_notificacion", "1");
    if (multiCuota)   params.set("multi_cuota", "1");
    if (diferencia)   params.set("diferencia", diferencia);
    if (medioPago === "WOMPI%" && wompiTipo) params.set("wompi_tipo", wompiTipo);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/cartera-preventiva?${params}`, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cargar datos");
      setData(json.data || []);
      setTotal(json.count || 0);
      setRenglones(typeof json.renglones === "number" ? json.renglones : null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setFetchError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }, [search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, multiCuota, diferencia, wompiTipo]);

  const fetchMedios = useCallback(async () => {
    const res  = await fetch("/api/cartera-preventiva/medios-pago");
    const raw: string[] = await res.json();

    // Agrupar WOMPI y Placetopay en una sola opción (Filtro 1, spec Wompi-Placetopay)
    const grouped: { label: string; value: string }[] = [];
    let addedWompi      = false;
    let addedPlacetopay = false;

    for (const m of raw) {
      if (m.toUpperCase().startsWith("WOMPI")) {
        if (!addedWompi) { grouped.push({ label: "Wompi", value: "WOMPI%" }); addedWompi = true; }
      } else if (m.toLowerCase().startsWith("placetopay")) {
        if (!addedPlacetopay) { grouped.push({ label: "Placetopay", value: "PLACETOPAY%" }); addedPlacetopay = true; }
      } else {
        grouped.push({ label: m, value: m });
      }
    }

    setMedios(grouped);
  }, []);

  const fetchMultiInscripcion = useCallback(async () => {
    try {
      const res  = await fetch("/api/cartera-preventiva/multi-inscripcion");
      const json = await res.json();
      if (res.ok) setMultiInscripcionDocs(new Set(json.documentos || []));
    } catch {
      // No bloquea la vista si falla — el panel de asociar simplemente no aparecerá.
    }
  }, []);

  const fetchUltimaCuota = useCallback(async () => {
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides");
      const json = await res.json();
      if (res.ok) setUltimaCuotaLlaves(new Set(json.llaves || []));
    } catch {
      // No bloquea la vista si falla — el botón simplemente arranca sin marcar.
    }
  }, []);

  const fetchSaldosFavor = useCallback(async () => {
    try {
      const res  = await fetch("/api/cartera-preventiva/saldos-favor");
      const json = await res.json();
      if (res.ok) setSaldosFavor(json.data || []);
    } catch {
      // No bloquea la vista si falla — el mensaje de saldo simplemente no aparecerá.
    }
  }, []);

  // Devuelve el conteo además de guardarlo: "Buscar archivos nuevos" lo compara
  // antes y después de la corrida para poder decir si Drive traía algo nuevo.
  const fetchStagingStatus = useCallback(async (): Promise<number | null> => {
    try {
      const res  = await fetch("/api/cartera-preventiva/staging-status");
      const json = await res.json();
      if (res.ok) { setStagingCount(json.count || 0); return json.count || 0; }
    } catch {
      // No bloquea la vista si falla — el banner simplemente no aparece.
    }
    return null;
  }, []);

  useEffect(() => {
    fetchMedios();
    fetchMultiInscripcion();
    fetchUltimaCuota();
    fetchSaldosFavor();
    fetchStagingStatus();
  }, [fetchMedios, fetchMultiInscripcion, fetchUltimaCuota, fetchSaldosFavor, fetchStagingStatus]);

  // Regla #4/#7 (revisada 30/07): documento es la señal FUERTE, correo la
  // débil. Basta con que coincida UNA de las dos — antes se exigían las dos
  // y eso dejaba invisibles los saldos de personas sin correo en cartera.
  const saldosPorDocumento = useMemo(() => {
    const map = new Map<string, SaldoFavorRow[]>();
    for (const s of saldosFavor) {
      const doc = (s.documento || "").trim();
      if (!doc) continue;
      if (!map.has(doc)) map.set(doc, []);
      map.get(doc)!.push(s);
    }
    return map;
  }, [saldosFavor]);

  // El correo solo empareja si PARECE un correo: en cartera hay valores
  // basura (ej. "0") que apuntan a 5 documentos distintos.
  const saldosPorCorreo = useMemo(() => {
    const map = new Map<string, SaldoFavorRow[]>();
    for (const s of saldosFavor) {
      const co = (s.correo || "").trim().toLowerCase();
      if (!co || !co.includes("@")) continue;
      if (!map.has(co)) map.set(co, []);
      map.get(co)!.push(s);
    }
    return map;
  }, [saldosFavor]);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      fetchData(1);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, multiCuota, diferencia, wompiTipo, fetchData]);


  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const buildDownloadParams = () => {
    const params = new URLSearchParams();
    if (search)       params.set("search", search);
    if (estado !== "todas") params.set("estado", estado);
    if (vencFrom)     params.set("venc_from", vencFrom);
    if (vencTo)       params.set("venc_to", vencTo);
    if (pagoParcial)  params.set("pago_parcial", "1");
    if (medioPago)    params.set("medio_pago", medioPago);
    if (payFrom)      params.set("pay_from", payFrom);
    if (payTo)        params.set("pay_to", payTo);
    if (cruceFrom)    params.set("cruce_from", cruceFrom);
    if (cruceTo)      params.set("cruce_to", cruceTo);
    if (conNotificacion) params.set("con_notificacion", "1");
    if (multiCuota)   params.set("multi_cuota", "1");
    if (diferencia)   params.set("diferencia", diferencia);
    if (medioPago === "WOMPI%" && wompiTipo) params.set("wompi_tipo", wompiTipo);
    return params;
  };

  const downloadExcel = async () => {
    setDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const res  = await fetch(`/api/cartera-preventiva/download?${buildDownloadParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      const allRows = json.data || [];
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const ws = XLSX.utils.json_to_sheet(allRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Cartera Preventiva");
      XLSX.writeFile(wb, `cartera_preventiva_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  };

  const downloadCSV = async () => {
    setDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const res  = await fetch(`/api/cartera-preventiva/download?${buildDownloadParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const rows: Record<string, unknown>[] = json.data || [];
      if (rows.length === 0) return;

      const headers = Object.keys(rows[0]);
      const csvLines = [
        headers.join(","),
        ...rows.map((row) =>
          headers.map((h) => {
            const val = row[h] ?? "";
            const str = String(val).replace(/"/g, '""');
            return str.includes(",") || str.includes("\n") || str.includes('"') ? `"${str}"` : str;
          }).join(",")
        ),
      ];

      const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `cartera_preventiva_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handlePage = (p: number) => {
    setPage(p);
    fetchData(p);
  };

  const fmt = (v: string | null) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  // Diferencia (§4.9): pasa a poder ser positiva (saldo a favor, pagó de más)
  // con la Fase 8 de matching-test. Antes solo era negativa (debe) o 0 (exacto).
  const paymentBadge = (row: CarteraPreventivaRow) => {
    // La cuota original de un pago parcial con faltante >= $50.000 lleva la
    // marca 'FALTA DE PAGO' (el faltante vive en `diferencia`, negativo). Su
    // estado real NO es "Pagada completa" ni "Saldo:" — es que le faltó el pago.
    // Va primero, para que gane sobre el chequeo de `diferencia < 0`.
    if (row.notificacion === "FALTA DE PAGO") {
      return <span className="bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">FALTA DE PAGO</span>;
    }
    if (!row.fecha_pago) {
      return <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Sin pago identificado</span>;
    }
    if (row.diferencia === 0) {
      return <span className="bg-emerald-50 text-emerald-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Pagada completa</span>;
    }
    if (row.diferencia != null && row.diferencia < 0) {
      return <span className="bg-orange-50 text-orange-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Saldo: {fmtMonto(Math.abs(row.diferencia))}</span>;
    }
    if (row.diferencia != null && row.diferencia > 0) {
      return <span className="bg-teal-50 text-teal-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Saldo a favor: {fmtMonto(row.diferencia)}</span>;
    }
    return <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">—</span>;
  };

  const isPagoParcial = (row: CarteraPreventivaRow) => row.diferencia != null && row.diferencia < 0;
  const isSaldoFavor = (row: CarteraPreventivaRow) => row.diferencia != null && row.diferencia > 0;

  // Spec Sobrantes-Excedentes §2: notificacion reemplaza las etiquetas viejas
  // de Fase 8 ('1 CUOTA + ABONO' etc, que ya no se producen) por 3 valores
  // nuevos con badge propio. Cualquier otro valor (incluidas esas etiquetas
  // viejas, si quedara alguna fila sin reprocesar) se muestra como texto plano.
  const notificacionBadge = (row: CarteraPreventivaRow) => {
    if (row.notificacion === "SOBRANTE") {
      return <span className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">SOBRANTE</span>;
    }
    if (row.notificacion === "EXCEDENTE") {
      return <span className="bg-purple-50 text-purple-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">EXCEDENTE</span>;
    }
    if (row.notificacion === "CONDONADO") {
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="bg-emerald-50 text-emerald-700 text-xs px-2 py-0.5 rounded-full">CONDONADO</span>
          {row.diferencia != null && <span className="text-xs text-gray-500">{fmtMonto(Math.abs(row.diferencia))}</span>}
        </span>
      );
    }
    // 'FALTA DE PAGO' ahora se muestra en el ESTADO de la cuota original
    // (`paymentBadge`), no en esta columna — la marca pasó de la cuota nueva
    // (la deuda) a la original, que es a la que le faltó el pago. La cuota
    // nueva viene con notificacion=NULL, así que aquí no debe aparecer.
    // `return null` explícito para que no caiga al texto plano de abajo.
    if (row.notificacion === "FALTA DE PAGO") {
      return null;
    }
    // Regla #8: cierre manual ya aplicado por el pipeline (valor_pago =
    // valor_a_cobrar, medio_pago = 'Cartera').
    if (row.notificacion === "CARTERA") {
      return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">CARTERA</span>;
    }
    return <span className="text-gray-500 text-xs whitespace-nowrap">{fmt(row.notificacion)}</span>;
  };

  // Spec Sobrantes-Excedentes §1: la decisión humana del modelo A/B. Aparece
  // solo cuando la decisión cambia algo (SOBRANTE→EXCEDENTE, o faltante→
  // condonar); en una fila sin discrepancia no hace falta. Toggle reversible:
  // marcar de nuevo lo pone en false y el pipeline revierte a modo A.
  const necesitaUltimaCuota = (row: CarteraPreventivaRow) =>
    row.notificacion === "SOBRANTE" || (row.diferencia != null && row.diferencia < 0);

  const rowTint = (row: CarteraPreventivaRow) => {
    if (!row.fecha_pago) return "";
    if (row.diferencia === 0) return "bg-emerald-50/30";
    if (row.diferencia != null && row.diferencia < 0) return "bg-orange-50/30";
    if (row.diferencia != null && row.diferencia > 0) return "bg-teal-50/30";
    return "";
  };

  // El pipeline corre 1 vez al día; las acciones de confirmación de esta
  // vista (asociar pago, cerrar cartera, corregir valor cuota) deben poder
  // reprocesarse de inmediato en vez de esperar al cron (spec §6).
  // Al terminar el recálculo hay que refrescar también el ledger: los saldos
  // los recalcula el pipeline, así que quedarse con la resta local de
  // handleAsociarSaldo dejaría el panel mostrando un número que ya no es.
  const { fireTrigger, reprocesoBadge, marcaFila } = useReproceso(() => { fetchData(page); fetchSaldosFavor(); });

  // Recarga los candidatos del panel desde el servidor. Se usa al abrirlo y
  // después de asociar: el decremento local del "restante" da feedback
  // inmediato, pero el valor_a_cobrar de las inscripciones solo se recalcula
  // releyendo — si no, el panel sigue mostrando lo que faltaba antes.
  const fetchAsociarData = useCallback(async (doc: string) => {
    setAsociarLoading((prev) => ({ ...prev, [doc]: true }));
    setAsociarError((prev) => ({ ...prev, [doc]: "" }));
    try {
      const res  = await fetch(`/api/cartera-preventiva/asociar?documento=${encodeURIComponent(doc)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cargar candidatos");
      setAsociarData((prev) => ({ ...prev, [doc]: { inscripciones: json.inscripciones || [], pagos: json.pagos || [] } }));
    } catch (err) {
      setAsociarError((prev) => ({ ...prev, [doc]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setAsociarLoading((prev) => ({ ...prev, [doc]: false }));
    }
  }, []);

  const toggleAsociarPanel = async (row: CarteraPreventivaRow) => {
    const doc = row.cruce_access;
    const willOpen = !asociarOpen[doc];
    setAsociarOpen((prev) => ({ ...prev, [doc]: willOpen }));
    if (willOpen && !asociarData[doc]) {
      await fetchAsociarData(doc);
    }
  };

  const handleAsociar = async (doc: string, pago: PagoAsociable, inscripcion: InscripcionPendiente, monto: number) => {
    const actionKey = `${pago.matching_key}:${inscripcion.llave}`;
    setRowSaving(actionKey);
    setAsociarError((prev) => ({ ...prev, [doc]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/asociar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matching_key: pago.matching_key, llave: inscripcion.llave, monto }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al asociar");
      setAsociarData((prev) => {
        const current = prev[doc];
        if (!current) return prev;
        const pagos = current.pagos
          .map((p) => p.matching_key === pago.matching_key ? { ...p, restante: p.restante - monto } : p)
          .filter((p) => p.restante > 0.01);
        return { ...prev, [doc]: { ...current, pagos } };
      });
      setAsociarMessage((prev) => ({ ...prev, [doc]: "Asociación guardada. Se aplica al terminar el recálculo." }));
      fetchAsociarData(doc);
      fireTrigger(inscripcion.llave);
    } catch (err) {
      setAsociarError((prev) => ({ ...prev, [doc]: err instanceof Error ? err.message : "Error inesperado" }));
      // El servidor revalida el sello y cuánto le queda al pago, así que un rechazo
      // suele significar que este panel está desactualizado (otra pestaña, o el
      // botón de al lado hace 14 segundos). Releer deja a la vista el estado real
      // en vez de un panel que sigue ofreciendo plata que ya no está.
      fetchAsociarData(doc);
    } finally {
      setRowSaving(null);
    }
  };

  // Buscar el documento destino antes de enviar. Reutiliza el GET del panel de
  // asociar: si el documento no tiene cuotas abiertas, `inscripciones` viene vacío
  // y eso es justamente lo que hay que enseñar — la plata no se podría usar allá.
  // El nombre a la vista es lo único que deja notar que se erró el documento.
  const handleBuscarDestino = async (key: string, documento: string) => {
    const doc = documento.trim();
    if (!doc) return;
    setEnviarBuscando((prev) => ({ ...prev, [key]: true }));
    setEnviarError((prev) => ({ ...prev, [key]: "" }));
    setEnviarDestino((prev) => ({ ...prev, [key]: null }));
    try {
      const res  = await fetch(`/api/cartera-preventiva/asociar?documento=${encodeURIComponent(doc)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al buscar el documento");
      const inscripciones = (json.inscripciones || []) as InscripcionPendiente[];
      setEnviarDestino((prev) => ({
        ...prev,
        [key]: {
          cliente: inscripciones.find((i) => i.cliente)?.cliente ?? null,
          inscripciones: [...new Set(inscripciones.map((i) => i.inscrip))],
          debe: inscripciones.reduce((a, i) => a + Number(i.valor_a_cobrar || 0), 0),
        },
      }));
    } catch (err) {
      setEnviarError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setEnviarBuscando((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Enviar plata de este pago al documento de OTRA persona. Queda como saldo a
  // favor de esa persona y allá se recoge con el botón "Asociar saldo" que ya
  // existe: son dos pasos a propósito, enviar y después asociar a la cuota que
  // corresponda. El servidor revalida las 6 condiciones dentro de la función de
  // base y responde 409; acá no se valida nada que allá no se vuelva a mirar.
  const handleEnviarSaldo = async (doc: string, pago: PagoAsociable, documentoDestino: string, monto: number) => {
    const key = `${doc}:${pago.matching_key}`;
    setRowSaving(`enviar:${key}`);
    setEnviarError((prev) => ({ ...prev, [key]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/enviar-saldo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matching_key: pago.matching_key,
          documento_destino: documentoDestino.trim(),
          monto,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al enviar el saldo");
      setEnviarOpen((prev) => ({ ...prev, [key]: false }));
      setEnviarDestino((prev) => ({ ...prev, [key]: null }));
      setEnviarDocInput((prev) => ({ ...prev, [key]: "" }));
      setEnviarMontoInput((prev) => ({ ...prev, [key]: "" }));
      setAsociarMessage((prev) => ({
        ...prev,
        [doc]: `Se enviaron ${fmtMonto(monto)} al documento ${documentoDestino.trim()}. Allá aparece como saldo a favor, listo para asociar a una cuota.`,
      }));
      // El restante del pago bajó y el ledger tiene una fila nueva: hay que releer
      // los dos, o el panel sigue ofreciendo plata que ya se fue.
      fetchAsociarData(doc);
      fetchSaldosFavor();
    } catch (err) {
      setEnviarError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
      // Un rechazo casi siempre significa que este panel está viejo (otra pestaña,
      // o el botón de al lado hace unos segundos). Mismo criterio que handleAsociar.
      fetchAsociarData(doc);
    } finally {
      setRowSaving(null);
    }
  };

  // Enviar a otro documento un saldo a favor que YA está en el ledger (sobrante o
  // descarte). Es el camino del día a día, y NO lo cubre el envío del panel de
  // asociar: aquel manda el restante LIBRE del pago, y su fórmula descuenta el
  // ledger — así que en cuanto el sobrante se vuelve saldo a favor responde "a este
  // pago no le queda nada". Caso que lo destapó: un diplomado de 2 cupos pagado de
  // un solo giro, con el segundo cupo a nombre de otra cédula.
  //
  // La plata sale de la fila de origen y nace a nombre del destino con el MISMO
  // matching_key (el cuadre del pipeline es por pago, no por persona), en una sola
  // transacción dentro de `trasladar_saldo_favor()`. Allá se recoge con el botón
  // "Asociar saldo" que ya existe: son dos pasos a propósito.
  const handleEnviarSaldoFavor = async (
    row: CarteraPreventivaRow,
    saldo: SaldoFavorRow,
    key: string,
    documentoDestino: string,
    monto: number,
  ) => {
    setRowSaving(`enviar:${key}`);
    setEnviarError((prev) => ({ ...prev, [key]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/enviar-saldo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saldo_id: saldo.id,
          documento_destino: documentoDestino.trim(),
          monto,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al enviar el saldo");
      setEnviarOpen((prev) => ({ ...prev, [key]: false }));
      setEnviarDestino((prev) => ({ ...prev, [key]: null }));
      setEnviarDocInput((prev) => ({ ...prev, [key]: "" }));
      setEnviarMontoInput((prev) => ({ ...prev, [key]: "" }));
      setRowMessage((prev) => ({
        ...prev,
        [row.llave]: `Se enviaron ${fmtMonto(monto)} al documento ${documentoDestino.trim()}. Allá aparece como saldo a favor, listo para asociar a una cuota.`,
      }));
      fetchSaldosFavor();
    } catch (err) {
      setEnviarError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
      // Un rechazo casi siempre significa que esta pantalla está vieja (otra
      // pestaña, o el botón de al lado hace unos segundos). Mismo criterio que
      // handleAsociar: releer deja a la vista lo que de verdad hay.
      fetchSaldosFavor();
    } finally {
      setRowSaving(null);
    }
  };

  // Deshacer un envío: un documento mal escrito manda plata a la pantalla de un
  // desconocido. Solo mientras nadie la haya asociado — de eso se encarga el
  // servidor, que revalida que el saldo siga intacto y responde 409 si no.
  //
  // ⚠️ No es un borrado: si el envío salió de otra fila del ledger, la plata tiene
  // que VOLVER ahí (a esa fila se le restó el monto). Eso lo hace
  // `deshacer_traslado_saldo()` en una sola transacción.
  const handleDeshacerTraslado = async (row: CarteraPreventivaRow, saldo: SaldoFavorRow) => {
    const actionKey = `deshacer:${saldo.id}`;
    setRowSaving(actionKey);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/enviar-saldo/deshacer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saldo_id: saldo.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al deshacer el envío");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Envío deshecho. La plata volvió a donde estaba." }));
      fetchSaldosFavor();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
      fetchSaldosFavor();
    } finally {
      setRowSaving(null);
    }
  };

  const toggleCierrePanel = (row: CarteraPreventivaRow) => {
    setCierreOpen((prev) => ({ ...prev, [row.llave]: !prev[row.llave] }));
    if (!cierreFecha[row.llave]) {
      setCierreFecha((prev) => ({ ...prev, [row.llave]: new Date().toISOString().slice(0, 10) }));
    }
  };

  // `cartera_preventiva.pago` es text en el esquema real y puede traer decimales
  // del Excel ("485086.5"). Nada que ver con parseMonto (entrada del usuario).
  const numPago = (v: string | null): number => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : 0;
  };

  // Cierre normal de una cuota CON pago identificado: copia valor_pago → pago
  // (misma escritura que "Cerrar Cartera" en bloque, pero para esta llave).
  // Escritura directa e inmediata, así que NO dispara reproceso — el pipeline
  // la respeta por idempotencia.
  const handleCerrarCuota = async (row: CarteraPreventivaRow) => {
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/cerrar-cuota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cerrar la cuota");
      setRowMessage((prev) => ({
        ...prev,
        [row.llave]: json.mensaje || (json.yaCerrada ? "La cuota ya estaba cerrada." : "Cuota cerrada."),
      }));
      fetchData(page);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleCerrarCartera = async (row: CarteraPreventivaRow) => {
    const fecha = cierreFecha[row.llave] || new Date().toISOString().slice(0, 10);
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const valorCuota = parseMonto(cuotaEdits[row.llave] ?? row.valor_cuota);
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llave: row.llave,
          cerrado_manual: true,
          fecha_pago_manual: fecha,
          medio_pago_manual: "Cartera",
          valor_pago_manual: valorCuota,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cerrar la cartera");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Cierre guardado. Se refleja al terminar el recálculo." }));
      setCierreOpen((prev) => ({ ...prev, [row.llave]: false }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #8 (Spec Auto Cartera): reabrir una cuota cerrada a mano — limpia
  // el override (cerrado_manual=false, fecha_pago_manual=null) para que el
  // pipeline la vuelva a poner pendiente en su próxima corrida.
  const handleReabrirCartera = async (row: CarteraPreventivaRow) => {
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, cerrado_manual: false, fecha_pago_manual: null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al reabrir");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Reapertura guardada. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleSaveValorCuota = async (row: CarteraPreventivaRow) => {
    const nuevo = parseMonto(cuotaEdits[row.llave]);
    if (!Number.isFinite(nuevo) || nuevo === row.valor_cuota) return;
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, valor_cuota_manual: nuevo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar el valor de cuota");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Valor de cuota corregido. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // La fecha corregida NO mueve plata ya aplicada: un pago se reparte una sola
  // vez en su vida (queda en pago_asociaciones). Lo que sí hace es ordenar los
  // pagos que entren DESPUÉS — el reparto llena siempre la cuota que vence
  // primero. Mover plata ya aplicada es a mano: descartar el pago y asociarlo
  // en la otra cuota.
  // Sin validar que la fecha sea futura ni que respete el orden de las demás
  // cuotas: corregir hacia atrás (10/09 → 10/08) es justamente el caso real.
  const handleSaveFechaVencimiento = async (row: CarteraPreventivaRow) => {
    const nueva = (vencEdits[row.llave] ?? "").trim();
    if (!nueva || nueva === row.fecha_vencimiento) return;
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, fecha_vencimiento_manual: nueva }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar la fecha de vencimiento");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Fecha de vencimiento corregida. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // El abono que trae el Excel (columna PAGO) corregido a mano. Cuando ese
  // abono cubre la cuota entera, `valor a cobrar` queda en 0 y la cuota sale
  // del reparto: ningún pago que llegue después puede entrarle (caso del doc
  // 1038415208, cuota 3681PN46253). Poner 0 = "ese abono no existe"; vaciar la
  // casilla borra la corrección y vuelve a lo que dice el Excel.
  // Mismo patrón que valor de cuota y fecha de vencimiento: la app registra la
  // decisión en cartera_preventiva_overrides y el pipeline escribe
  // cartera_preventiva.pago y recalcula `valor a cobrar`. Nunca al revés.
  const handleSavePago = async (row: CarteraPreventivaRow, valor: string) => {
    const raw   = valor.trim();
    const nuevo = raw === "" ? null : parseMonto(raw);
    if (nuevo !== null && (!Number.isFinite(nuevo) || nuevo < 0)) return;
    // Un abono mayor a la cuota dejaría `valor a cobrar` en negativo, que
    // ninguna pantalla sabe mostrar. Se compara contra el valor guardado, no
    // contra el que pueda estar a medio escribir en la casilla de al lado.
    if (nuevo !== null && nuevo > row.valor_cuota) {
      setRowError((prev) => ({
        ...prev,
        [row.llave]: `El abono no puede superar el valor de la cuota (${fmtMonto(row.valor_cuota)}).`,
      }));
      return;
    }
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, pago_manual: nuevo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar el abono");
      setRowMessage((prev) => ({
        ...prev,
        [row.llave]: nuevo === null
          ? "Corrección del abono eliminada. Se refleja al terminar el recálculo."
          : "Abono corregido. Se refleja al terminar el recálculo.",
      }));
      // Sin matchingKey: es una llave de CUOTA, no de pago — mandarla como
      // matchingKey haría que cruzar.py buscara un pago inexistente y no
      // recalculara nada.
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleToggleUltimaCuota = async (row: CarteraPreventivaRow) => {
    const nuevoValor = !ultimaCuotaLlaves.has(row.llave);
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, es_ultima_cuota: nuevoValor }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar");
      setUltimaCuotaLlaves((prev) => {
        const next = new Set(prev);
        if (nuevoValor) next.add(row.llave); else next.delete(row.llave);
        return next;
      });
      setRowMessage((prev) => ({ ...prev, [row.llave]: nuevoValor ? "Marcada como última cuota. Se refleja al terminar el recálculo." : "Desmarcada. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #7: asocia un saldo a favor puntual (una fila del ledger) a la
  // cuota destino. El cierre lo escribe el pipeline en su próxima corrida —
  // acá solo se decrementa el disponible local para feedback inmediato.
  const handleAsociarSaldo = async (row: CarteraPreventivaRow, saldo: SaldoFavorRow, monto: number) => {
    const actionKey = `saldo:${saldo.id}:${row.llave}`;
    setRowSaving(actionKey);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/asociar-saldo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saldo_id: saldo.id, llave: row.llave, monto }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al asociar el saldo");
      setSaldosFavor((prev) => prev
        .map((s) => s.id === saldo.id ? { ...s, disponible: s.disponible - monto } : s)
        .filter((s) => s.disponible > 0.01));
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Saldo asociado. Se aplica al terminar el recálculo." }));
      fetchSaldosFavor();
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #3: trae los pagos asociados a esta cuota para poder descartar uno.
  const toggleDescartarPanel = async (row: CarteraPreventivaRow) => {
    const willOpen = !descartarOpen[row.llave];
    setDescartarOpen((prev) => ({ ...prev, [row.llave]: willOpen }));
    if (willOpen && !descartarData[row.llave]) {
      setDescartarLoading((prev) => ({ ...prev, [row.llave]: true }));
      setDescartarError((prev) => ({ ...prev, [row.llave]: "" }));
      try {
        const res  = await fetch(`/api/cartera-preventiva/asociaciones?llave=${encodeURIComponent(row.llave)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al cargar pagos asociados");
        setDescartarData((prev) => ({ ...prev, [row.llave]: json.data || [] }));
      } catch (err) {
        setDescartarError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
      } finally {
        setDescartarLoading((prev) => ({ ...prev, [row.llave]: false }));
      }
    }
  };

  const handleDescartarPago = async (row: CarteraPreventivaRow, asociacion: AsociacionRow) => {
    setRowSaving(`descarte:${asociacion.id}`);
    setDescartarError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/descartar-pago", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asociacion_id: asociacion.id,
          llave: row.llave,
          matching_key: asociacion.matching_key,
          documento: row.cruce_access,
          correo: row.correo,
          cliente: row.cliente,
          inscrip: row.inscrip,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descartar el pago");
      setDescartarData((prev) => ({ ...prev, [row.llave]: (prev[row.llave] || []).filter((a) => a.id !== asociacion.id) }));
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Pago descartado. La cuota vuelve a pendiente al terminar el recálculo." }));
      fetchSaldosFavor();
      fireTrigger(row.llave);
    } catch (err) {
      setDescartarError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // §1: al escribir el documento se buscan sus inscripciones — las que ya están en
  // cartera (se hereda, caso 1) y las del Excel de inscripciones (caso 2, la
  // inscripción todavía no está en cartera). De paso prellena los descriptivos.
  const buscarInscripciones = async (documento: string) => {
    const doc = documento.trim();
    if (!doc) { setAgregarInscripciones([]); setAgregarEnCartera([]); return; }
    setAgregarBuscando(true);
    setAgregarError("");
    try {
      const res  = await fetch(`/api/cartera-preventiva/cuota?documento=${encodeURIComponent(doc)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al buscar inscripciones");
      setAgregarInscripciones(json.inscripciones || []);
      setAgregarEnCartera(json.en_cartera || []);
      setAgregarForm((prev) => ({
        ...prev,
        inscrip: (json.inscripciones || []).length === 1 ? json.inscripciones[0] : prev.inscrip,
        cliente: prev.cliente || json.prefill?.cliente || "",
        programa: prev.programa || json.prefill?.programa || "",
        correo: prev.correo || json.prefill?.correo || "",
        moneda: json.prefill?.moneda || prev.moneda,
        sistema_financiero: json.prefill?.sistema_financiero || prev.sistema_financiero,
      }));
    } catch (err) {
      setAgregarError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setAgregarBuscando(false);
    }
  };

  const handleAgregarCuota = async () => {
    setAgregarGuardando(true);
    setAgregarError("");
    try {
      const res  = await fetch("/api/cartera-preventiva/cuota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...agregarForm, valor_cuota: parseMonto(agregarForm.valor_cuota) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al crear la cuota");
      setAgregarMessage(`Cuota ${json.llave} creada. Reprocesando el cruce…`);
      setAgregarOpen(false);
      setAgregarForm({
        cruce_access: "", inscrip: "", fecha_vencimiento: "", valor_cuota: "",
        cliente: "", programa: "", correo: "", moneda: "COP", sistema_financiero: "SIST_F_NUEVO",
      });
      setAgregarInscripciones([]);
      setAgregarEnCartera([]);
      fetchData(page);
      fireTrigger();
    } catch (err) {
      setAgregarError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setAgregarGuardando(false);
    }
  };

  // Qué día alcanza "Cerrar Cartera": el filtro "Día del Cruce" de la vista si está
  // puesto, y si no, hoy — el mismo criterio que aplica el endpoint. El aviso tiene que
  // nombrarlo: desde que el botón respeta el filtro puede alcanzar cualquier rango, y
  // no se puede deshacer desde la UI.
  const cierreDiaLabel =
    cruceFrom && cruceTo
      ? (cruceFrom === cruceTo ? `el ${cruceFrom}` : `entre el ${cruceFrom} y el ${cruceTo}`)
      : cruceFrom
      ? `desde el ${cruceFrom}`
      : cruceTo
      ? `hasta el ${cruceTo}`
      : "hoy";

  // §2.2: cierra en bloque las cuotas cruzadas en el día alcanzado que coincidan con
  // los filtros de la vista. No dispara reproceso: la escritura es inmediata y el
  // pipeline la respeta (su chequeo de idempotencia compara valor_pago contra la suma
  // de asociaciones, que no cambia al cerrar).
  const handleCerrarDia = async () => {
    setCerrandoDia(true);
    setCerrarDiaError("");
    setCerrarDiaMessage("");
    try {
      const res  = await fetch("/api/cartera-preventiva/cerrar-dia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(buildDownloadParams()),
          dia: new Date().toLocaleDateString("en-CA"), // YYYY-MM-DD en la zona del usuario
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cerrar la cartera del día");
      const partes = [`Se cerraron ${json.cerradas} cuota(s) cruzada(s) ${cierreDiaLabel}.`];
      if (json.saltadas > 0) partes.push(`${json.saltadas} ya estaban cerradas o sin pago identificado.`);
      if (json.errores?.length) partes.push(`Con errores: ${json.errores.join(" · ")}`);
      setCerrarDiaMessage(partes.join(" "));
      setCerrarDiaOpen(false);
      fetchData(page);
    } catch (err) {
      setCerrarDiaError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setCerrandoDia(false);
    }
  };

  // Regla #6: irreversible desde la UI — las verificaciones se hacen antes de
  // apretar, tal como advierte el spec.
  const handleActivarCartera = async () => {
    if (!confirm(`¿Activar la cartera nueva (${stagingCount.toLocaleString("es-CO")} cuotas)? La versión activa actual se archivará. Esta acción es irreversible desde esta pantalla.`)) return;
    setActivando(true);
    setActivarError("");
    setActivarMessage("");
    try {
      const res  = await fetch("/api/cartera-preventiva/activar", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al activar la cartera");
      setActivarMessage("Cambiando la versión de la cartera...");
      // §3: esperar a que el swap termine de verdad antes de recargar. Sin esto el
      // banner se quedaba pegado en "Actualizando la vista…" con datos de la versión
      // anterior. El tope duro evita dejarlo colgado si el VPS deja de responder.
      const inicio = Date.now();
      let vistoCorriendo = false;
      while (Date.now() - inicio < ACTIVAR_MAX_MS) {
        await new Promise((r) => setTimeout(r, ACTIVAR_POLL_MS));
        const st = await fetch("/api/cartera-preventiva/activar/status").then((r) => r.json()).catch(() => null);
        if (!st) break;
        if (st.status === "running") { vistoCorriendo = true; continue; }
        if (vistoCorriendo || Date.now() - inicio > ACTIVAR_GRACE_MS) break;
      }
      setActivarMessage("Cartera nueva activada.");
      await fetchStagingStatus();
      setPage(1);
      fetchData(1);
      // El cruce hay que rehacerlo sobre la cartera nueva: era uno de los 3 huecos (§3).
      fireTrigger();
    } catch (err) {
      setActivarError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setActivando(false);
    }
  };

  return (
    <div className="p-5 pb-8 space-y-4">
      {reprocesoBadge}
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <h1 className="text-lg font-semibold text-gray-900">Cartera Preventiva</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <BuscarArchivosButton onDone={async () => { await fetchData(page); return fetchStagingStatus(); }} />
          <button
            onClick={() => setAgregarOpen(true)}
            className="flex items-center gap-1.5 border border-black/10 text-brand-700 text-sm px-3.5 py-1.5 rounded-full hover:bg-brand-50 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Agregar cuota
          </button>
          <button
            onClick={() => { setCerrarDiaOpen(true); setCerrarDiaMessage(""); setCerrarDiaError(""); }}
            disabled={cerrandoDia}
            title={`Pasa valor_pago a pago en las cuotas cruzadas ${cierreDiaLabel} que coincidan con los filtros de la vista`}
            className="flex items-center gap-1.5 bg-slate-700 text-white text-sm px-3.5 py-1.5 rounded-full shadow-sm hover:bg-slate-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {cerrandoDia ? "Cerrando..." : "Cerrar Cartera"}
          </button>
        </div>
      </div>

      {(cerrarDiaMessage || cerrarDiaError) && (
        <div className={`text-sm rounded-xl px-3.5 py-2 border ${cerrarDiaError ? "text-red-600 bg-red-50 border-red-200/80" : "text-green-700 bg-green-50 border-green-200/80"}`}>
          {cerrarDiaError || cerrarDiaMessage}
        </div>
      )}

      {/* §2.2: confirmación obligatoria, sin deshacer. */}
      {cerrarDiaOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={() => !cerrandoDia && setCerrarDiaOpen(false)}>
          <div className={`${PANEL} animate-pop-in max-w-md w-full p-6 space-y-3`} onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-gray-900">
              ¿Estás seguro de cerrar la cartera cruzada {cierreDiaLabel}?
            </h2>
            <p className="text-sm text-gray-600">
              Se marcarán como cobradas las cuotas cruzadas <span className="font-medium">{cierreDiaLabel}</span> que
              coincidan con los filtros puestos en la vista (<span className="font-medium">{total.toLocaleString("es-CO")}</span> en
              pantalla): el valor identificado pasa a la columna <span className="font-medium">Pago</span> y
              lo que falte queda a la vista en <span className="font-medium">Valor a Cobrar</span>.
            </p>
            <p className="text-xs text-gray-500">
              No se puede deshacer desde esta pantalla. Las cuotas ya cerradas y las que no tienen
              pago identificado se saltan solas —así que el número final puede ser menor, y darle
              dos veces no hace daño.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setCerrarDiaOpen(false)}
                disabled={cerrandoDia}
                className="text-sm px-3.5 py-1.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleCerrarDia}
                disabled={cerrandoDia}
                className="text-sm px-3.5 py-1.5 rounded-full bg-slate-700 text-white hover:bg-slate-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
              >
                {cerrandoDia ? "Cerrando..." : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {agregarMessage && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200/80 rounded-xl px-3.5 py-2">
          {agregarMessage}
        </div>
      )}

      {/* §1: crear a mano una cuota que no vino en el Excel. */}
      {agregarOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 py-10 overflow-y-auto" onClick={() => !agregarGuardando && setAgregarOpen(false)}>
          <div className={`${PANEL} animate-pop-in max-w-lg w-full p-6 space-y-3`} onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-gray-900">Agregar cuota</h2>
            <p className="text-xs text-gray-500">
              Para cuotas que deberían estar en la cartera y no vinieron en el Excel. El pago de esa
              persona no se pierde: en cuanto exista la cuota, el reproceso lo aplica en cuanto termina.
            </p>

            <div className="space-y-2.5">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Documento *</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={agregarForm.cruce_access}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, cruce_access: e.target.value }))}
                    onBlur={(e) => buscarInscripciones(e.target.value)}
                    placeholder="Documento del deudor"
                    className={`flex-1 ${INPUT}`}
                  />
                  <button
                    onClick={() => buscarInscripciones(agregarForm.cruce_access)}
                    disabled={agregarBuscando || !agregarForm.cruce_access.trim()}
                    className="text-sm px-3 py-1.5 rounded-xl border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 whitespace-nowrap"
                  >
                    {agregarBuscando ? "Buscando..." : "Buscar"}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Inscripción (INCP) *</label>
                {agregarInscripciones.length > 0 ? (
                  <select
                    value={agregarForm.inscrip}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, inscrip: e.target.value }))}
                    className={`w-full ${INPUT}`}
                  >
                    <option value="" className="text-gray-900">Elige una inscripción...</option>
                    {agregarInscripciones.map((i) => (
                      <option key={i} value={i} className="text-gray-900">
                        {i}{agregarEnCartera.includes(i) ? " — ya está en cartera" : " — solo en el Excel de inscripciones"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={agregarForm.inscrip}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, inscrip: e.target.value }))}
                    placeholder="Busca el documento para elegir, o escríbela"
                    className={`w-full ${INPUT}`}
                  />
                )}
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Fecha de vencimiento *</label>
                  <input
                    type="date"
                    value={agregarForm.fecha_vencimiento}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, fecha_vencimiento: e.target.value }))}
                    className={`w-full ${INPUT}`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Valor de la cuota *</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={agregarForm.valor_cuota}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, valor_cuota: e.target.value }))}
                    onBlur={(e) => setAgregarForm((p) => ({ ...p, valor_cuota: formatMonto(e.target.value) }))}
                    className={`w-full ${INPUT}`}
                  />
                </div>
              </div>

              {agregarForm.fecha_vencimiento && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200/80 rounded-lg px-2 py-1.5">
                  La fecha de vencimiento define el orden de cobro: una fecha vieja hace que esta
                  cuota se cobre <span className="font-medium">antes</span> que las que ya estaban pendientes.
                </p>
              )}

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Cliente</label>
                  <input type="text" value={agregarForm.cliente}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, cliente: e.target.value }))}
                    className={`w-full ${INPUT}`} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Programa</label>
                  <input type="text" value={agregarForm.programa}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, programa: e.target.value }))}
                    className={`w-full ${INPUT}`} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Correo</label>
                  <input type="text" value={agregarForm.correo}
                    onChange={(e) => setAgregarForm((p) => ({ ...p, correo: e.target.value }))}
                    className={`w-full ${INPUT}`} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Moneda</label>
                    <input type="text" value={agregarForm.moneda}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, moneda: e.target.value }))}
                      className={`w-full ${INPUT}`} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Sist. Fin.</label>
                    <input type="text" value={agregarForm.sistema_financiero}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, sistema_financiero: e.target.value }))}
                      className={`w-full ${INPUT}`} />
                  </div>
                </div>
              </div>

              {agregarInscripciones.length > 1 && (
                <p className="text-[11px] text-gray-500">
                  Ojo: si esta persona queda con dos inscripciones debiendo, el sistema deja de
                  aplicarle los pagos automáticamente y pasan a asociación manual. Es a propósito,
                  para que la plata no caiga en la inscripción equivocada.
                </p>
              )}
              <p className="text-[11px] text-gray-400">
                Al hacer &quot;Cargar Cartera&quot; esta cuota no se recrea: se archiva con la versión, como
                cualquier otra. Si sigue faltando, se vuelve a crear.
              </p>
            </div>

            {agregarError && <p className="text-xs text-red-600">{agregarError}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setAgregarOpen(false)}
                disabled={agregarGuardando}
                className="text-sm px-3.5 py-1.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleAgregarCuota}
                disabled={
                  agregarGuardando ||
                  !agregarForm.cruce_access.trim() ||
                  !agregarForm.inscrip.trim() ||
                  !agregarForm.fecha_vencimiento ||
                  !(parseMonto(agregarForm.valor_cuota) > 0)
                }
                className="text-sm px-3.5 py-1.5 rounded-full bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
              >
                {agregarGuardando ? "Creando..." : "Crear cuota"}
              </button>
            </div>
          </div>
        </div>
      )}

      {stagingCount > 0 && (
        <div className="animate-slide-down bg-amber-50 border border-amber-200/80 rounded-2xl px-6 py-3.5 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm font-medium text-amber-900">
              Hay una cartera nueva pendiente de cargar ({stagingCount.toLocaleString("es-CO")} cuotas)
            </p>
            <p className="text-xs text-amber-700 mt-0.5">Al activarla, la versión actual se archiva. Es irreversible desde esta pantalla — verifica antes de confirmar.</p>
            {activarMessage && <p className="text-xs text-green-700 mt-1">{activarMessage}</p>}
            {activarError && <p className="text-xs text-red-600 mt-1">{activarError}</p>}
          </div>
          <button
            onClick={handleActivarCartera}
            disabled={activando}
            className="text-sm px-3.5 py-1.5 rounded-full bg-amber-600 text-white hover:bg-amber-700 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 whitespace-nowrap"
          >
            {activando ? "Activando..." : "Cargar Cartera"}
          </button>
        </div>
      )}

      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] px-6 py-4 space-y-3`}>
        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative w-80">
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por documento, cliente, INCP o VAL..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`w-full ${INPUT} rounded-full pl-9 pr-3.5`}
            />
          </div>
          <select
            value={estado}
            onChange={(e) => { setEstado(e.target.value); setPage(1); }}
            className={INPUT}
          >
            <option value="todas" className="text-gray-900">Todas</option>
            <option value="pendiente" className="text-gray-900">Pendiente</option>
            <option value="resuelta" className="text-gray-900">Resuelta</option>
            <option value="cerrada" className="text-gray-900">Cerradas</option>
          </select>
          <select
            value={medioPago}
            onChange={(e) => {
              setMedioPago(e.target.value);
              if (e.target.value !== "WOMPI%") setWompiTipo("");
              setPage(1);
            }}
            className={INPUT}
          >
            <option value="" className="text-gray-900">Todos los medios de pago</option>
            {medios.map((m) => (
              <option key={m.value} value={m.value} className="text-gray-900">{m.label}</option>
            ))}
          </select>
          <select
            value={wompiTipo}
            onChange={(e) => { setWompiTipo(e.target.value); setPage(1); }}
            disabled={medioPago !== "WOMPI%"}
            className={`${INPUT} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <option value="" className="text-gray-900">Todos (Wompi)</option>
            <option value="automatico" className="text-gray-900">Automáticos</option>
            <option value="manual" className="text-gray-900">Manuales</option>
          </select>
          {/* Diferencia: el umbral de "le falta plata" depende de la moneda de la
              cuota (ver lib/carteraDiferencia.ts). Cada cuota que califica baja con
              sus líneas derivadas pegadas debajo, aunque esas no califiquen solas. */}
          <select
            value={diferencia}
            onChange={(e) => { setDiferencia(e.target.value); setPage(1); }}
            className={INPUT}
            title="Le falta plata: deuda de $50.000 o más (15 USD o más en cuotas en dólares). Le sobra plata: diferencia de $1 en adelante."
          >
            <option value="" className="text-gray-900">Cualquier diferencia</option>
            <option value="falta" className="text-gray-900">Le falta plata</option>
            <option value="sobra" className="text-gray-900">Le sobra plata</option>
          </select>
        </div>

        <div className="flex gap-6 flex-wrap text-sm text-gray-600 items-center">
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha Vencimiento</span>
            <input type="date" value={vencFrom} onChange={(e) => { setVencFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={vencTo} onChange={(e) => { setVencTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha Pago</span>
            <input type="date" value={payFrom} onChange={(e) => { setPayFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={payTo} onChange={(e) => { setPayTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pagoParcial}
              onChange={(e) => { setPagoParcial(e.target.checked); setPage(1); }}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
            />
            <span className="font-medium">Solo pago parcial</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="font-medium">Día del Cruce</span>
            <input type="date" value={cruceFrom} onChange={(e) => { setCruceFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={cruceTo} onChange={(e) => { setCruceTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={conNotificacion}
              onChange={(e) => { setConNotificacion(e.target.checked); setPage(1); }}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
            />
            <span className="font-medium">Con notificación de pago de más</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={multiCuota}
              onChange={(e) => { setMultiCuota(e.target.checked); setPage(1); }}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
            />
            <span className="font-medium">Inscripciones con varias cuotas</span>
          </label>
          {(search || estado !== "todas" || vencFrom || vencTo || pagoParcial || medioPago || payFrom || payTo || cruceFrom || cruceTo || conNotificacion || multiCuota || diferencia || wompiTipo) && (
            <button
              onClick={() => { setSearch(""); setEstado("todas"); setVencFrom(""); setVencTo(""); setPagoParcial(false); setMedioPago(""); setPayFrom(""); setPayTo(""); setCruceFrom(""); setCruceTo(""); setConNotificacion(false); setMultiCuota(false); setDiferencia(""); setWompiTipo(""); setPage(1); }}
              className="text-red-500 hover:text-red-700 text-xs underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      <div className="px-1 flex items-center justify-between gap-3">
        <span className="text-sm text-gray-500">
          {loading
            ? "Cargando..."
            : diferencia && renglones !== null
              // Con el filtro puesto se pagina por CUOTA, no por renglón: una cuota
              // arrastra sus líneas derivadas, así que los dos números no coinciden.
              ? `${total.toLocaleString("es-CO")} cuotas (${renglones.toLocaleString("es-CO")} renglones)`
              : `${total.toLocaleString("es-CO")} registros encontrados`}
        </span>

        <div ref={dropdownRef} className="relative">
          <button
            onClick={() => setDropdownOpen((o) => !o)}
            disabled={loading || total === 0}
            className="flex items-center gap-1.5 bg-brand-600 text-white text-sm px-3.5 py-1.5 rounded-full shadow-sm hover:bg-brand-700 hover:brightness-105 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Descargar
            <svg className={`w-3 h-3 ml-0.5 transition-transform duration-200 ease-(--ease-spring) ${dropdownOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {dropdownOpen && (
            <div className="animate-pop-in origin-top-right absolute right-0 mt-1.5 w-44 bg-white border border-black/[0.06] rounded-xl shadow-[0_8px_24px_-8px_rgba(0,0,0,0.2)] z-50 overflow-hidden py-1">
              <button
                onClick={downloadExcel}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100"
              >
                Descargar Excel
              </button>
              <button
                onClick={downloadCSV}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100"
              >
                Descargar CSV
              </button>
            </div>
          )}
        </div>
      </div>

      {fetchError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2">
          {fetchError}
        </div>
      )}

      <div className={`${PANEL} animate-fade-in [animation-delay:100ms] overflow-hidden`}>
        <div ref={tableContainerRef} className="overflow-auto max-h-[65vh]">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-50 text-gray-500 text-left border-b border-black/[0.06]">
                <th className="px-4 py-3 font-medium whitespace-nowrap">Llave</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Sistema Financiero</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Inscrip.</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Cliente</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Moneda</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fecha Vencimiento</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Valor Cuota</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Valor a Cobrar</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Programa</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fecha Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Medio de Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Valor Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 1</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 2</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Correo Electrónico</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Notificación</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Diferencia</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Documento</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Estado</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Acciones</th>
              </tr>
            </thead>
            <tbody key={page} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 21 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={21} className="text-center py-12 text-gray-400">No hay registros</td>
                </tr>
              ) : (
                data.map((row) => {
                  const parcial = isPagoParcial(row);
                  const saldoFavor = isSaldoFavor(row);
                  const pendiente = !row.fecha_pago;
                  // Cerrada = alguien la cerró y `pago` ya refleja el valor_pago
                  // (si el pago cambió después, vuelve a ofrecerse el cierre).
                  const cerrada = row.pago_confirmado != null && row.pago_confirmado === row.valor_pago;
                  // El Excel ya trae el pago en `pago` (mismo número, o centavos
                  // de diferencia): la cuota ya está cobrada en el Sistema
                  // Financiero, así que no hay nada que cerrar — y cerrarla
                  // duplicaría el pago, porque la fórmula acumula.
                  // Ojo: `pago` es text en la base y puede traer decimales
                  // ("485086.5"), así que va parseFloat — NO parseMonto, que
                  // está hecho para la entrada del usuario ("." = miles).
                  const yaCobrada = !cerrada && row.valor_pago != null
                    && Math.abs(numPago(row.pago) - row.valor_pago) <= 100;
                  const saving = rowSaving === row.llave;
                  const cuotaValue = cuotaEdits[row.llave] ?? formatMonto(row.valor_cuota);
                  const cuotaChanged = cuotaValue.trim() !== "" && parseMonto(cuotaValue) !== row.valor_cuota && !Number.isNaN(parseMonto(cuotaValue));
                  // <input type="date"> entrega YYYY-MM-DD, el mismo formato que
                  // guarda la columna `date` — no pasar por Date(), que
                  // interpreta ese string en UTC y en Colombia devuelve el día
                  // anterior.
                  const vencValue   = vencEdits[row.llave] ?? row.fecha_vencimiento ?? "";
                  const vencChanged = vencValue.trim() !== "" && vencValue !== row.fecha_vencimiento;
                  // Abono del Excel, editable. `pago` es text y puede traer
                  // centavos ("485086.5"): se muestra redondeado a pesos como el
                  // resto de la vista, y la comparación "cambió / no cambió" va
                  // contra ese mismo entero — si no, toda cuota con decimales
                  // saldría con el ✓ puesto de entrada. Vaciar la casilla borra
                  // la corrección (pago_manual = null), y por eso cuenta como
                  // cambio solo si la fila hoy trae abono.
                  const pagoActual  = Math.round(numPago(row.pago));
                  const pagoGuardado = row.pago != null && row.pago.trim() !== "";
                  const pagoValue   = pagoEdits[row.llave] ?? (pagoGuardado ? formatMonto(pagoActual) : "");
                  const pagoNum     = parseMonto(pagoValue);
                  const pagoChanged = pagoValue.trim() === ""
                    ? pagoGuardado
                    : Number.isFinite(pagoNum) && pagoNum !== pagoActual;
                  const puedeAsociar = multiInscripcionDocs.has(row.cruce_access);
                  // Regla #4/#7: mensaje + botón de asociar saldo a favor,
                  // solo en las cuotas que necesitan dinero (pendiente o pago
                  // parcial).
                  // Unión de las dos señales, sin repetir un saldo que caiga por ambas.
                  const porDoc    = saldosPorDocumento.get((row.cruce_access || "").trim()) || [];
                  const porCorreo = saldosPorCorreo.get((row.correo || "").trim().toLowerCase()) || [];
                  const saldosDeLaFila = Array.from(
                    new Map([...porDoc, ...porCorreo].map((s) => [s.id, s])).values()
                  );
                  const grupo = saldosDeLaFila.length
                    ? { total: saldosDeLaFila.reduce((a, s) => a + Number(s.disponible), 0),
                        rows:  saldosDeLaFila }
                    : undefined;
                  const necesitaDinero = pendiente || parcial;
                  // El botón NO se esconde por haber originado el saldo: si la cuota
                  // necesita dinero, tiene que poder recibirlo, venga de donde venga.
                  // (Antes había un `!esOrigenSaldo` aquí, para no ofrecerlo en la
                  // cuota que ya muestra su badge "Saldo a favor" — pero ese badge
                  // exige fecha_pago + diferencia > 0, o sea que `necesitaDinero` ya
                  // es false ahí. Lo único que bloqueaba de más eran las cuotas que
                  // originaron un saldo y quedaron debiendo: desde el 3/8 el pipeline
                  // ya no pinta la plata descartada sobre su cuota de origen, así que
                  // esas quedaban sin badge Y sin botón — con descartes en dos cuotas
                  // del mismo documento, ninguna podía recibir la plata.)
                  // ...y no en una línea de deuda cuya cuota original siga abierta:
                  // ahí la plata va en la original, si no se pagaría dos veces.
                  const puedeAsociarSaldo = !!grupo && grupo.total > 0 && necesitaDinero
                                            && !row.original_abierta;
                  // Enviar ese saldo a otra persona NO exige que esta cuota necesite
                  // dinero: el caso normal es justo el contrario — la cuota quedó
                  // pagada y lo que sobró es de otra cédula (un diplomado de 2 cupos
                  // pagado de un solo giro). Si el bloque solo apareciera cuando se
                  // puede asociar, la fila con badge "Saldo a favor" —que es donde
                  // está la plata a repartir— no ofrecería nada, que es el mismo
                  // agujero que dejó el envío del panel de Asociar (ese panel solo
                  // se abre con 2+ inscripciones debiendo).
                  const tieneSaldo = !!grupo && grupo.total > 0;
                  const cuotaRestante = pendiente ? row.valor_a_cobrar : Math.abs(row.diferencia ?? 0);
                  // Regla #3: descartar solo tiene sentido sobre un pago real
                  // ya aplicado — un cierre manual de cartera no tiene pago
                  // asociado que descartar.
                  const puedeDescartar = !pendiente && row.medio_pago !== "Cartera" && row.notificacion !== "CARTERA";
                  return (
                  <tr key={row.id} className={`hover:bg-gray-50/70 transition-colors duration-100 align-top ${rowTint(row)}`}>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.llave)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.sistema_financiero)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      {fmt(row.inscrip)}
                      {(row.cuotas_inscripcion ?? 1) > 1 && (
                        <span className="ml-1.5 text-[11px] text-gray-500">{row.cuotas_inscripcion} cuotas</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cliente)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.moneda)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <input
                          type="date"
                          value={vencValue}
                          onChange={(e) => setVencEdits((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                          disabled={saving}
                          className="w-36 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                        {vencChanged && (
                          <button
                            onClick={() => handleSaveFechaVencimiento(row)}
                            disabled={saving}
                            title="Guardar corrección de fecha de vencimiento"
                            className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            ✓
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={cuotaValue}
                          onChange={(e) => setCuotaEdits((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                          onBlur={(e) => setCuotaEdits((prev) => ({ ...prev, [row.llave]: formatMonto(e.target.value) }))}
                          disabled={saving}
                          className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                        {cuotaChanged && (
                          <button
                            onClick={() => handleSaveValorCuota(row)}
                            disabled={saving}
                            title="Guardar corrección de valor de cuota"
                            className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            ✓
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={pagoValue}
                          title="Abono que trae el Excel de cartera. 0 = ese abono no existe; vacío borra la corrección."
                          onChange={(e) => setPagoEdits((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                          onBlur={(e) => setPagoEdits((prev) => ({ ...prev, [row.llave]: formatMonto(e.target.value) }))}
                          disabled={saving}
                          className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                        {pagoChanged && (
                          <button
                            onClick={() => handleSavePago(row, pagoValue)}
                            disabled={saving}
                            title="Guardar corrección del abono"
                            className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            ✓
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_a_cobrar)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.programa)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.fecha_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.medio_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_1)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_2)}</td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className="text-gray-500">{fmt(row.correo_elec)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">{notificacionBadge(row)}</td>
                    <td className={`px-4 py-2.5 text-gray-700 whitespace-nowrap ${parcial ? "bg-orange-50/60" : saldoFavor ? "bg-teal-50/60" : ""}`}>
                      <div className="flex items-center gap-1">
                        {parcial && <span title="Pago parcial: queda saldo pendiente" className="text-orange-600 text-xs">⚠️</span>}
                        {saldoFavor && <span title="Saldo a favor: pagó de más" className="text-teal-600 text-xs">✓</span>}
                        <span>{fmtMonto(row.diferencia)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cruce_access)}</td>
                    <td className="px-4 py-2.5">{paymentBadge(row)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1 min-w-[160px]">
                        {necesitaUltimaCuota(row) && (
                          <button
                            onClick={() => handleToggleUltimaCuota(row)}
                            disabled={saving}
                            title="Marca que esta es la última cuota de la inscripción (modo B): un sobrante pasa a excedente final, un faltante se condona hasta $50k"
                            className={`text-xs px-2 py-1 rounded-lg border active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 ${
                              ultimaCuotaLlaves.has(row.llave)
                                ? "bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700"
                                : "border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                            }`}
                          >
                            {ultimaCuotaLlaves.has(row.llave) ? "✓ Última cuota" : "Es la última cuota"}
                          </button>
                        )}
                        {/* Cuota CON pago identificado → cierre normal directo:
                            no hay nada que capturar, el pago ya se conoce. */}
                        {row.valor_pago != null && !cerrada && !yaCobrada && (
                          <button
                            onClick={() => handleCerrarCuota(row)}
                            disabled={saving}
                            title="Pasa el valor pagado al campo Pago — la cuota queda cerrada"
                            className="text-xs px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            {saving ? "Cerrando..." : "Cerrar Cuota"}
                          </button>
                        )}
                        {cerrada && (
                          <span className="text-[11px] text-gray-400 whitespace-nowrap">Cuota cerrada</span>
                        )}
                        {yaCobrada && (
                          <span
                            title="El Sistema Financiero ya la registra cobrada (Pago = Valor pagado) — no hay nada que cerrar"
                            className="text-[11px] text-gray-400 whitespace-nowrap"
                          >
                            Ya cobrada
                          </span>
                        )}
                        {/* Cuota SIN pago identificado → cierre manual "Cartera":
                            la persona declara que se pagó por cartera. */}
                        {pendiente && row.valor_pago == null && (
                          <button
                            onClick={() => toggleCierrePanel(row)}
                            disabled={saving}
                            title="La cuota no tiene pago identificado — declararla pagada por cartera"
                            className="text-xs px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            {cierreOpen[row.llave] ? "Ocultar cierre" : "Marcar pagada por Cartera"}
                          </button>
                        )}
                        {!pendiente && row.notificacion === "CARTERA" && (
                          <button
                            onClick={() => handleReabrirCartera(row)}
                            disabled={saving}
                            title="Deshace el cierre manual — la cuota vuelve a pendiente en el próximo cruce"
                            className="text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            Reabrir
                          </button>
                        )}
                        {cierreOpen[row.llave] && (
                          <div className="animate-fade-in bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1.5">
                            <label className="block text-[11px] text-gray-500">Fecha de pago</label>
                            <input
                              type="date"
                              value={cierreFecha[row.llave] || ""}
                              onChange={(e) => setCierreFecha((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                            />
                            <p className="text-[11px] text-gray-400">Medio: Cartera · Valor: {fmtMonto(parseMonto(cuotaEdits[row.llave] ?? row.valor_cuota))}</p>
                            <button
                              onClick={() => handleCerrarCartera(row)}
                              disabled={saving}
                              className="w-full text-xs px-2 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              {saving ? "Guardando..." : "Confirmar cierre"}
                            </button>
                          </div>
                        )}
                        {puedeAsociar && pendiente && (
                          <button
                            onClick={() => toggleAsociarPanel(row)}
                            disabled={saving}
                            className="text-xs px-2 py-1 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            {asociarOpen[row.cruce_access] ? "Ocultar asociar" : "⚠️ Asociar"}
                          </button>
                        )}
                        {asociarOpen[row.cruce_access] && (
                          <div className="animate-fade-in bg-amber-50/60 border border-amber-200/80 rounded-lg p-2 space-y-1.5 w-64">
                            {asociarLoading[row.cruce_access] ? (
                              <p className="text-xs text-gray-500">Cargando...</p>
                            ) : asociarError[row.cruce_access] ? (
                              <p className="text-xs text-red-600">{asociarError[row.cruce_access]}</p>
                            ) : (
                              <>
                                <p className="text-[11px] text-amber-800">
                                  Hay {asociarData[row.cruce_access]?.pagos.length ?? 0} pago(s) de este documento, falta asociar a una inscripción.
                                </p>
                                {(asociarData[row.cruce_access]?.pagos || []).map((pago) => (
                                  <div key={pago.matching_key} className="bg-white border border-gray-200 rounded-lg p-1.5 space-y-1">
                                    <p className="text-[11px] text-gray-600">
                                      {fmt(pago.transaction_code_1)} · {fmt(pago.payment_date)} · restante {fmtMonto(pago.restante)}
                                    </p>
                                    {(asociarData[row.cruce_access]?.inscripciones || []).map((ins) => {
                                      const exacto = Math.abs(ins.valor_a_cobrar - pago.restante) < 1;
                                      const actionKey = `${pago.matching_key}:${ins.llave}`;
                                      const savingAction = rowSaving === actionKey;
                                      const otroValorKey = `${pago.matching_key}:${ins.llave}`;
                                      return (
                                        <div key={ins.llave} className="flex items-center justify-between gap-1 text-[11px]">
                                          <span className={exacto ? "text-emerald-700 font-medium" : "text-gray-600"}>
                                            {ins.inscrip} ({fmt(ins.sistema_financiero)}) — {fmtMonto(ins.valor_a_cobrar)}
                                            {exacto && " ✓ calza"}
                                          </span>
                                          <div className="flex items-center gap-1">
                                            <button
                                              onClick={() => handleAsociar(row.cruce_access, pago, ins, pago.restante)}
                                              disabled={savingAction}
                                              className="px-1.5 py-0.5 rounded bg-brand-700 text-white hover:bg-brand-800 disabled:opacity-50"
                                            >
                                              Todo
                                            </button>
                                            <input
                                              type="text"
                                              inputMode="numeric"
                                              placeholder="otro $"
                                              value={montoOtroValor[otroValorKey] || ""}
                                              onChange={(e) => setMontoOtroValor((prev) => ({ ...prev, [otroValorKey]: e.target.value }))}
                                              onBlur={(e) => setMontoOtroValor((prev) => ({ ...prev, [otroValorKey]: formatMonto(e.target.value) }))}
                                              className="w-24 border border-gray-300 rounded px-1 py-0.5"
                                            />
                                            <button
                                              onClick={() => {
                                                const monto = parseMonto(montoOtroValor[otroValorKey]);
                                                if (Number.isFinite(monto) && monto > 0) handleAsociar(row.cruce_access, pago, ins, monto);
                                              }}
                                              disabled={savingAction}
                                              className="px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                            >
                                              OK
                                            </button>
                                          </div>
                                        </div>
                                      );
                                    })}
                                    {/* Enviar a otro documento: un pago puede cubrir a dos
                                        personas (una empresa por su empleado, un familiar por
                                        otro). Hasta acá la plata solo se podía mover dentro
                                        del documento del pagador. */}
                                    {(() => {
                                      const key = `${row.cruce_access}:${pago.matching_key}`;
                                      const destino = enviarDestino[key];
                                      const docDestino = (enviarDocInput[key] || "").trim();
                                      const savingEnvio = rowSaving === `enviar:${key}`;
                                      const montoEnvio = enviarMontoInput[key]
                                        ? parseMonto(enviarMontoInput[key])
                                        : pago.restante;
                                      const montoValido = Number.isFinite(montoEnvio) && montoEnvio > 0
                                        && montoEnvio <= pago.restante + 0.01;
                                      return (
                                        <div className="pt-1 border-t border-gray-100">
                                          <button
                                            onClick={() => setEnviarOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
                                            className="text-[11px] px-1.5 py-0.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
                                          >
                                            {enviarOpen[key] ? "Ocultar envío" : "Enviar saldo a otro documento"}
                                          </button>
                                          {enviarOpen[key] && (
                                            <div className="animate-fade-in mt-1 space-y-1 bg-indigo-50/60 border border-indigo-200/80 rounded-lg p-1.5">
                                              <div className="flex items-center gap-1">
                                                <input
                                                  type="text"
                                                  placeholder="Documento destino"
                                                  value={enviarDocInput[key] || ""}
                                                  onChange={(e) => {
                                                    setEnviarDocInput((prev) => ({ ...prev, [key]: e.target.value }));
                                                    setEnviarDestino((prev) => ({ ...prev, [key]: null }));
                                                  }}
                                                  className="flex-1 min-w-0 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                                />
                                                <button
                                                  onClick={() => handleBuscarDestino(key, docDestino)}
                                                  disabled={!docDestino || enviarBuscando[key]}
                                                  className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                                >
                                                  {enviarBuscando[key] ? "..." : "Buscar"}
                                                </button>
                                              </div>
                                              {destino && (
                                                destino.inscripciones.length === 0 ? (
                                                  <p className="text-[11px] text-red-600">
                                                    Ese documento no tiene cuotas abiertas en la cartera: la plata no se
                                                    vería en ninguna pantalla.
                                                  </p>
                                                ) : (
                                                  <>
                                                    <p className="text-[11px] text-indigo-900">
                                                      ✓ {fmt(destino.cliente)}
                                                    </p>
                                                    <p className="text-[11px] text-indigo-700">
                                                      {destino.inscripciones.length} inscripción(es) con cuotas abiertas
                                                      ({destino.inscripciones.join(", ")}) · debe {fmtMonto(destino.debe)}
                                                    </p>
                                                    <div className="flex items-center gap-1">
                                                      <input
                                                        type="text"
                                                        inputMode="numeric"
                                                        placeholder={formatMonto(pago.restante)}
                                                        value={enviarMontoInput[key] || ""}
                                                        onChange={(e) => setEnviarMontoInput((prev) => ({ ...prev, [key]: e.target.value }))}
                                                        onBlur={(e) => setEnviarMontoInput((prev) => ({ ...prev, [key]: formatMonto(e.target.value) }))}
                                                        className="w-24 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                                      />
                                                      <button
                                                        onClick={() => handleEnviarSaldo(row.cruce_access, pago, docDestino, montoEnvio)}
                                                        disabled={savingEnvio || !montoValido}
                                                        title={montoValido ? undefined : `A este pago solo le quedan ${fmtMonto(pago.restante)}`}
                                                        className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-700 text-white hover:bg-indigo-800 disabled:opacity-50"
                                                      >
                                                        {savingEnvio ? "Enviando..." : "Enviar saldo"}
                                                      </button>
                                                    </div>
                                                    <p className="text-[11px] text-gray-500">
                                                      Por defecto se envía todo el restante. La plata llega como saldo a
                                                      favor de esa persona y allá se asocia a la cuota que corresponda.
                                                    </p>
                                                  </>
                                                )
                                              )}
                                              {enviarError[key] && (
                                                <p className="text-[11px] text-red-600">{enviarError[key]}</p>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })()}
                                  </div>
                                ))}
                                {asociarMessage[row.cruce_access] && (
                                  <p className="text-[11px] text-green-700">{asociarMessage[row.cruce_access]}</p>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {tieneSaldo && (
                          <div className="bg-teal-50/60 border border-teal-200/80 rounded-lg p-1.5 space-y-1">
                            <p className="text-[11px] text-teal-800">
                              Esta inscripción tiene un saldo a favor de {fmtMonto(grupo!.total)}
                            </p>
                            <button
                              onClick={() => setAsociarSaldoOpen((prev) => ({ ...prev, [row.llave]: !prev[row.llave] }))}
                              disabled={saving}
                              className="text-xs px-2 py-1 rounded-lg border border-teal-300 text-teal-700 hover:bg-teal-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              {asociarSaldoOpen[row.llave]
                                ? "Ocultar"
                                : puedeAsociarSaldo ? "Asociar pago" : "Enviar a otro documento"}
                            </button>
                            {asociarSaldoOpen[row.llave] && (
                              <div className="animate-fade-in space-y-1 pt-1">
                                {grupo!.rows.map((saldo) => {
                                  const otroKey = `saldo:${saldo.id}:${row.llave}`;
                                  const savingAction = rowSaving === otroKey;
                                  const montoTodo = Math.min(saldo.disponible, cuotaRestante || saldo.disponible);
                                  // El envío se lleva por fila de ledger Y por cuota a la
                                  // vista: el mismo saldo se muestra en todas las cuotas de
                                  // la persona, y compartir el estado haría que escribir el
                                  // documento en una abriera el panel en todas.
                                  const envKey   = `${row.llave}:s${saldo.id}`;
                                  const destino  = enviarDestino[envKey];
                                  const docDest  = (enviarDocInput[envKey] || "").trim();
                                  const savingEnvio = rowSaving === `enviar:${envKey}`;
                                  // Por defecto, TODO lo disponible de ESTA fila — no lo del
                                  // pago entero, que puede tener plata en otras filas y en el
                                  // restante libre. Son botones distintos y cada uno mueve lo
                                  // suyo.
                                  const montoEnvio = enviarMontoInput[envKey]
                                    ? parseMonto(enviarMontoInput[envKey])
                                    : Number(saldo.disponible);
                                  const montoValido = Number.isFinite(montoEnvio) && montoEnvio > 0
                                    && montoEnvio <= Number(saldo.disponible) + 0.01;
                                  return (
                                    <div key={saldo.id} className="bg-white border border-gray-200 rounded-lg p-1.5 space-y-1">
                                      <p className="text-[11px] text-gray-600">
                                        {fmt(saldo.cliente)} · {fmt(saldo.fecha)} · disponible {fmtMonto(saldo.disponible)}
                                      </p>
                                      {/* Un envío se puede deshacer SOLO mientras nadie lo haya
                                          asociado: si ya se usó una parte, la plata está en una
                                          cuota y el camino es "Descartar pago" allá. El servidor
                                          revalida lo mismo y responde 409. */}
                                      {saldo.origen === "traslado" && (
                                        <div className="flex items-center gap-1">
                                          <span className="text-[11px] text-indigo-700">Enviado desde otro documento</span>
                                          {Number(saldo.disponible) === Number(saldo.monto) && (
                                            <button
                                              onClick={() => handleDeshacerTraslado(row, saldo)}
                                              disabled={rowSaving === `deshacer:${saldo.id}`}
                                              className="text-[11px] px-1.5 py-0.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                                            >
                                              {rowSaving === `deshacer:${saldo.id}` ? "..." : "Deshacer envío"}
                                            </button>
                                          )}
                                        </div>
                                      )}
                                      {/* Asociar a ESTA cuota solo si la cuota necesita dinero.
                                          Enviar a otra persona, en cambio, va siempre: el caso
                                          normal es una cuota ya pagada cuyo sobrante es de otra
                                          cédula. */}
                                      {puedeAsociarSaldo && (
                                        <div className="flex items-center gap-1 text-[11px]">
                                          <button
                                            onClick={() => handleAsociarSaldo(row, saldo, montoTodo)}
                                            disabled={savingAction}
                                            className="px-1.5 py-0.5 rounded bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-50"
                                          >
                                            {cuotaRestante && cuotaRestante < saldo.disponible ? "Todo lo que falta" : "Todo"}
                                          </button>
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            placeholder="otro $"
                                            value={saldoOtroValor[otroKey] || ""}
                                            onChange={(e) => setSaldoOtroValor((prev) => ({ ...prev, [otroKey]: e.target.value }))}
                                            onBlur={(e) => setSaldoOtroValor((prev) => ({ ...prev, [otroKey]: formatMonto(e.target.value) }))}
                                            className="w-24 border border-gray-300 rounded px-1 py-0.5"
                                          />
                                          <button
                                            onClick={() => {
                                              const monto = parseMonto(saldoOtroValor[otroKey]);
                                              if (Number.isFinite(monto) && monto > 0) handleAsociarSaldo(row, saldo, monto);
                                            }}
                                            disabled={savingAction}
                                            className="px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                          >
                                            OK
                                          </button>
                                        </div>
                                      )}
                                      <div className="pt-1 border-t border-gray-100">
                                        <button
                                          onClick={() => setEnviarOpen((prev) => ({ ...prev, [envKey]: !prev[envKey] }))}
                                          className="text-[11px] px-1.5 py-0.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
                                        >
                                          {enviarOpen[envKey] ? "Ocultar envío" : "Enviar a otro documento"}
                                        </button>
                                        {enviarOpen[envKey] && (
                                          <div className="animate-fade-in mt-1 space-y-1 bg-indigo-50/60 border border-indigo-200/80 rounded-lg p-1.5">
                                            <div className="flex items-center gap-1">
                                              <input
                                                type="text"
                                                placeholder="Documento destino"
                                                value={enviarDocInput[envKey] || ""}
                                                onChange={(e) => {
                                                  setEnviarDocInput((prev) => ({ ...prev, [envKey]: e.target.value }));
                                                  setEnviarDestino((prev) => ({ ...prev, [envKey]: null }));
                                                }}
                                                className="flex-1 min-w-0 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                              />
                                              <button
                                                onClick={() => handleBuscarDestino(envKey, docDest)}
                                                disabled={!docDest || enviarBuscando[envKey]}
                                                className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                              >
                                                {enviarBuscando[envKey] ? "..." : "Buscar"}
                                              </button>
                                            </div>
                                            {destino && (
                                              destino.inscripciones.length === 0 ? (
                                                <p className="text-[11px] text-red-600">
                                                  Ese documento no tiene cuotas abiertas en la cartera: la plata no se
                                                  vería en ninguna pantalla.
                                                </p>
                                              ) : (
                                                <>
                                                  {/* El nombre a la vista es lo único que deja notar
                                                      que se erró el documento antes de mandarle plata
                                                      a un desconocido. */}
                                                  <p className="text-[11px] text-indigo-900">✓ {fmt(destino.cliente)}</p>
                                                  <p className="text-[11px] text-indigo-700">
                                                    {destino.inscripciones.length} inscripción(es) con cuotas abiertas
                                                    ({destino.inscripciones.join(", ")}) · debe {fmtMonto(destino.debe)}
                                                  </p>
                                                  <div className="flex items-center gap-1">
                                                    <input
                                                      type="text"
                                                      inputMode="numeric"
                                                      placeholder={formatMonto(saldo.disponible)}
                                                      value={enviarMontoInput[envKey] || ""}
                                                      onChange={(e) => setEnviarMontoInput((prev) => ({ ...prev, [envKey]: e.target.value }))}
                                                      onBlur={(e) => setEnviarMontoInput((prev) => ({ ...prev, [envKey]: formatMonto(e.target.value) }))}
                                                      className="w-24 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                                    />
                                                    <button
                                                      onClick={() => handleEnviarSaldoFavor(row, saldo, envKey, docDest, montoEnvio)}
                                                      disabled={savingEnvio || !montoValido}
                                                      title={montoValido ? undefined : `Ese saldo solo tiene ${fmtMonto(saldo.disponible)} disponibles`}
                                                      className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-700 text-white hover:bg-indigo-800 disabled:opacity-50"
                                                    >
                                                      {savingEnvio ? "Enviando..." : "Enviar saldo"}
                                                    </button>
                                                  </div>
                                                  <p className="text-[11px] text-gray-500">
                                                    Por defecto se envía todo lo disponible de este saldo. La plata llega
                                                    como saldo a favor de esa persona y allá se asocia a la cuota que
                                                    corresponda.
                                                  </p>
                                                </>
                                              )
                                            )}
                                            {enviarError[envKey] && (
                                              <p className="text-[11px] text-red-600">{enviarError[envKey]}</p>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        {puedeDescartar && (
                          <button
                            onClick={() => toggleDescartarPanel(row)}
                            disabled={saving}
                            className="text-xs px-2 py-1 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            {descartarOpen[row.llave] ? "Ocultar descartar" : "Descartar pago"}
                          </button>
                        )}
                        {descartarOpen[row.llave] && (
                          <div className="animate-fade-in bg-red-50/60 border border-red-200/80 rounded-lg p-2 space-y-1.5 w-64">
                            {descartarLoading[row.llave] ? (
                              <p className="text-xs text-gray-500">Cargando...</p>
                            ) : descartarError[row.llave] ? (
                              <p className="text-xs text-red-600">{descartarError[row.llave]}</p>
                            ) : (descartarData[row.llave] || []).length === 0 ? (
                              <p className="text-[11px] text-gray-500">No hay pagos asociados a descartar.</p>
                            ) : (
                              (descartarData[row.llave] || []).map((asociacion) => {
                                const savingAction = rowSaving === `descarte:${asociacion.id}`;
                                return (
                                  <div key={asociacion.id} className="bg-white border border-gray-200 rounded-lg p-1.5 flex items-center justify-between gap-2">
                                    <p className="text-[11px] text-gray-600">
                                      {fmt(asociacion.transaction_code_1)} · {fmt(asociacion.payment_date)} · {fmtMonto(asociacion.monto)}
                                    </p>
                                    <button
                                      onClick={() => handleDescartarPago(row, asociacion)}
                                      disabled={savingAction}
                                      className="text-[11px] px-1.5 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                                    >
                                      {savingAction ? "..." : "Descartar"}
                                    </button>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                        {marcaFila(row.llave)}
                        {rowMessage[row.llave] && <span className="text-[11px] text-green-700">{rowMessage[row.llave]}</span>}
                        {rowError[row.llave] && <span className="text-[11px] text-red-600">{rowError[row.llave]}</span>}
                        {!pendiente && !necesitaUltimaCuota(row) && !cierreOpen[row.llave] && !puedeDescartar && !tieneSaldo && !rowMessage[row.llave] && (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-black/[0.06] text-sm text-gray-600">
            <span>Página {page} de {totalPages}</span>
            <div className="flex gap-1">
              <button onClick={() => handlePage(1)} disabled={page === 1}
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring)">«</button>
              <button onClick={() => handlePage(page - 1)} disabled={page === 1}
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring)">‹</button>
              {[...Array(Math.min(5, totalPages))].map((_, i) => {
                const p = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
                return (
                  <button key={p} onClick={() => handlePage(p)}
                    className={`min-w-7 h-7 px-2 rounded-full hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) ${p === page ? "bg-brand-600 text-white shadow-sm hover:bg-brand-600" : ""}`}>
                    {p}
                  </button>
                );
              })}
              <button onClick={() => handlePage(page + 1)} disabled={page === totalPages}
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring)">›</button>
              <button onClick={() => handlePage(totalPages)} disabled={page === totalPages}
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring)">»</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
