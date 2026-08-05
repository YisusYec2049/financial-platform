"use client";

import { useEffect, useState, useCallback, useRef, useLayoutEffect } from "react";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";
import { useReproceso } from "@/lib/useReproceso";
import CruceExcepcionesView, { type CruceExcepcionesViewRef } from "@/components/CruceExcepcionesView";

type TriggerStatus = "idle" | "running" | "done";

function TriggerCruceButton({ onDone }: { onDone: () => void }) {
  const [status, setStatus]   = useState<TriggerStatus>("idle");
  const [message, setMessage] = useState("");
  const pollRef               = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch("/api/cruce/trigger/status");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar el estado");

        if (json.status === "done") {
          stopPolling();
          setStatus("done");
          setMessage(json.exit_code === 0 ? "Cruce actualizado" : "El cruce terminó con errores");
          onDone();
          setTimeout(() => setStatus("idle"), 3000);
        }
      } catch (err) {
        stopPolling();
        setStatus("idle");
        setMessage(err instanceof Error ? err.message : "Error inesperado");
      }
    }, 4000);
  }, [stopPolling, onDone]);

  const handleClick = async () => {
    setStatus("running");
    setMessage("");
    try {
      const statusRes  = await fetch("/api/cruce/trigger/status");
      const statusJson = await statusRes.json();
      if (statusJson.status !== "running") {
        const res  = await fetch("/api/cruce/trigger", { method: "POST" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "No se pudo iniciar la actualización");
      }
      startPolling();
    } catch (err) {
      setStatus("idle");
      setMessage(err instanceof Error ? err.message : "Error inesperado");
    }
  };

  return (
    <div className="flex items-center gap-2">
      {message && (
        <span className="text-xs text-gray-500">{message}</span>
      )}
      <button
        onClick={handleClick}
        disabled={status === "running"}
        className="flex items-center gap-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 px-3.5 py-1.5 rounded-full active:scale-95 transition-all duration-200 ease-(--ease-spring)"
      >
        <svg className={`w-3.5 h-3.5 ${status === "running" ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {status === "running" ? "Actualizando..." : "Actualizar cruce"}
      </button>
    </div>
  );
}

function SegmentedControl({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
    if (active) setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, [value, options]);

  return (
    <div ref={containerRef} className="relative inline-flex bg-gray-100 rounded-xl p-1 gap-1">
      <div
        className="absolute top-1 bottom-1 rounded-lg bg-white shadow-sm transition-all duration-300 ease-(--ease-spring)"
        style={{ left: indicator.left, width: indicator.width }}
      />
      {options.map((opt) => (
        <button
          key={opt.value}
          data-value={opt.value}
          onClick={() => onChange(opt.value)}
          className={`relative z-10 px-4 py-1.5 text-sm font-medium rounded-lg whitespace-nowrap transition-colors duration-200 ${
            value === opt.value ? "text-gray-900" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function buildXlsx(rows: Record<string, unknown>[], filename: string, sheetName: string) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

function buildCsv(rows: Record<string, unknown>[], filename: string) {
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
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type CruceRow = {
  matching_key: string;
  identification: string;
  payment_date: string;
  transaction_code_1: string;
  transaction_code_2: string;
  email: string;
  payment_method: string;
  program: string;
  phone: string;
  payment_amount: number;
  incp: string | null;
  correo_2: string | null;
  nombre: string | null;
  metodo_de_pago: string | null;
  ci: string | null;
  cruce: string | null;
};

/**
 * El PATCH escribe los cinco campos COMO BLOQUE: lo que no venga en el cuerpo se guarda
 * como `null`. Por eso el formulario arranca con los valores actuales de la fila y los manda
 * todos, aunque aquí solo se editen INCP y Correo(2) — mandar solo el INCP borraría
 * `nombre`/`metodo_de_pago`/`ci` (los datos del pagador de WOMPI), y no se recuperan solos:
 * al quedar la fila `corregido_manual`, la re-evaluación de WOMPI del pipeline la salta.
 */
type EditState = { incp: string; correo_2: string; nombre: string; metodo_de_pago: string; ci: string };

export default function CruceView() {
  const [tab, setTab]                     = useState<"todas" | "excepciones">("todas");
  const [data, setData]                   = useState<CruceRow[]>([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useSessionState("cruce.search", "");
  const [paymentMethod, setPaymentMethod] = useSessionState("cruce.paymentMethod", "");
  const [payFrom, setPayFrom]             = useSessionState("cruce.payFrom", "");
  const [payTo, setPayTo]                 = useSessionState("cruce.payTo", "");
  const [regFrom, setRegFrom]             = useSessionState("cruce.regFrom", "");
  const [regTo, setRegTo]                 = useSessionState("cruce.regTo", "");
  const [sinCrucePreventiva, setSinCrucePreventiva] = useSessionState("cruce.sinCrucePreventiva", false);
  const [wompiTipo, setWompiTipo]         = useSessionState("cruce.wompiTipo", "");
  const [methods, setMethods]             = useState<{ label: string; value: string }[]>([]);
  const [fetchError, setFetchError]       = useState("");
  const [dropdownOpen, setDropdownOpen]   = useState(false);
  const [wompiDropdownOpen, setWompiDropdownOpen] = useState(false);
  const [edits, setEdits]                 = useState<Record<string, EditState>>({});
  const [savingKey, setSavingKey]         = useState<string | null>(null);
  const [rowMessage, setRowMessage]       = useState<Record<string, string>>({});
  const [rowError, setRowError]           = useState<Record<string, string>>({});
  const searchTimeout                     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef                = useRef<AbortController | null>(null);
  const tableContainerRef                 = useRef<HTMLDivElement>(null);
  const excepcionesRef                    = useRef<CruceExcepcionesViewRef>(null);
  const dropdownRef                       = useRef<HTMLDivElement>(null);
  const wompiDropdownRef                   = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 100;

  const fetchMethods = useCallback(async () => {
    const res  = await fetch("/api/transactions/payment-methods");
    const raw: string[] = await res.json();

    // Agrupar WOMPI y Placetopay en una sola opción
    const grouped: { label: string; value: string }[] = [];
    let addedWompi      = false;
    let addedPlacetopay = false;

    for (const m of raw) {
      if (m.toUpperCase().startsWith("WOMPI")) {
        if (!addedWompi) { grouped.push({ label: "WOMPI", value: "WOMPI%" }); addedWompi = true; }
      } else if (m.toLowerCase().startsWith("placetopay")) {
        if (!addedPlacetopay) { grouped.push({ label: "Placetopay", value: "Placetopay%" }); addedPlacetopay = true; }
      } else {
        grouped.push({ label: m, value: m });
      }
    }

    setMethods(grouped);
  }, []);

  const fetchData = useCallback(async (currentPage = 1) => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setLoading(true);
    setFetchError("");
    const params = new URLSearchParams();
    if (search)        params.set("search", search);
    if (paymentMethod) params.set("payment_method", paymentMethod);
    if (payFrom)        params.set("pay_from", payFrom);
    if (payTo)          params.set("pay_to", payTo);
    if (regFrom)        params.set("reg_from", regFrom);
    if (regTo)          params.set("reg_to", regTo);
    if (sinCrucePreventiva) params.set("sin_cruce_preventiva", "1");
    if (paymentMethod === "WOMPI%" && wompiTipo) params.set("wompi_tipo", wompiTipo);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/cruce?${params}`, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cargar datos");
      setData(json.data || []);
      setTotal(json.count || 0);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setFetchError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }, [search, paymentMethod, payFrom, payTo, regFrom, regTo, sinCrucePreventiva, wompiTipo]);

  useEffect(() => {
    fetchMethods();
  }, [fetchMethods]);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      fetchData(1);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search, paymentMethod, payFrom, payTo, regFrom, regTo, sinCrucePreventiva, wompiTipo, fetchData]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (wompiDropdownRef.current && !wompiDropdownRef.current.contains(e.target as Node)) {
        setWompiDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const buildDownloadParams = () => {
    const params = new URLSearchParams();
    if (search)        params.set("search", search);
    if (paymentMethod) params.set("payment_method", paymentMethod);
    if (payFrom)        params.set("pay_from", payFrom);
    if (payTo)          params.set("pay_to", payTo);
    if (regFrom)        params.set("reg_from", regFrom);
    if (regTo)          params.set("reg_to", regTo);
    if (sinCrucePreventiva) params.set("sin_cruce_preventiva", "1");
    if (paymentMethod === "WOMPI%" && wompiTipo) params.set("wompi_tipo", wompiTipo);
    return params;
  };

  const downloadExcel = async () => {
    setDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const res  = await fetch(`/api/cruce/download?${buildDownloadParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      const allRows = json.data || [];
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      buildXlsx(allRows, `cruce_cartera_${new Date().toISOString().slice(0, 10)}.xlsx`, "Cruce de Cartera");
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
      const res  = await fetch(`/api/cruce/download?${buildDownloadParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const rows: Record<string, unknown>[] = json.data || [];
      buildCsv(rows, `cruce_cartera_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  };

  // Reporte "WOMPI del día": TODOS los WOMPI que entraron ese día (fecha de ingreso),
  // leídos del consolidado — incluidos los apartados, que ya no están en el cruce.
  // Es un reporte de métricas link vs. manual, así que no lleva estado del cruce ni
  // marca de apartado: las columnas del consolidado + una sola que dice el método.
  // Usa el filtro reg_from/reg_to de la vista si está puesto; si no, hoy.
  const downloadWompiReport = async (format: "excel" | "csv") => {
    setWompiDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const hoy = new Date().toISOString().slice(0, 10);
      const rf = regFrom || hoy;
      const rt = regTo   || hoy;
      const params = new URLSearchParams({ reg_from: rf, reg_to: rt });
      const res  = await fetch(`/api/cruce/wompi-report/download?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const rows: Record<string, unknown>[] = json.data || [];
      if (rows.length === 0) {
        setFetchError("No hay pagos WOMPI para ese día (fecha de ingreso).");
        return;
      }
      // Una sola columna legible al frente. `metodo_de_pago` la llena el pipeline en
      // cada corrida para todos los WOMPI; si viene vacía es que aún no ha corrido
      // sobre ese pago, y se deja vacía en vez de adivinar.
      const enriched = rows.map(({ incp, ...r }) => {
        const esAutomatico = r.metodo_de_pago === "WOMPI (Genera Link)";
        return {
          "Método WOMPI": esAutomatico
            ? "Automático"
            : r.metodo_de_pago === "PAGOS MANUALES"
            ? "Manual"
            : "",
          // El INCP lo pega la ruta desde cruce_cartera (cualquier estado) o, para los
          // apartados, desde pagos_apartados.incp_resuelto. Vacío cuando no hay dato.
          //
          // `incp` se saca del spread a propósito: NO es una columna del consolidado
          // sino un añadido de la ruta, así que dejarlo pasar sacaría la misma cadena
          // dos veces en el Excel, como "INCP" y como "incp". Distinto de
          // `metodo_de_pago`, que sí es columna real y se conserva cruda al lado de su
          // versión legible.
          INCP: incp ?? "",
          ...r,
          // Pedido del área (5/8): en los automáticos el Programa sale solo con su
          // código. Se corta en el PRIMER " - " (con espacios: sin ellos, un código
          // con guion interno se partiría por la mitad), porque hay nombres de
          // catálogo que traen dos — "DPWBI47 - Dip. en Power BI - Análisis y
          // Visualización…". Va DESPUÉS del spread o `...r` lo pisa con el valor
          // original; como la clave ya existe en `r`, el orden de columnas no cambia.
          //
          // Los manuales NO se tocan: ahí el Programa sale de `ref. 2` del CSV, que
          // es texto libre de quien paga. Hoy 237 de 927 traen el formato por copiar
          // y pegar del catálogo, pero nadie lo garantiza — el día que alguien
          // escriba "Pago cuota 2 - agosto", el reporte diría que el programa es
          // "Pago cuota 2".
          program: esAutomatico ? String(r.program ?? "").split(" - ")[0].trim() : r.program,
        };
      });
      if (format === "excel") buildXlsx(enriched, `wompi_del_dia_${rt}.xlsx`, "WOMPI del día");
      else buildCsv(enriched, `wompi_del_dia_${rt}.csv`);
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

  const handleTriggerDone = () => {
    if (tab === "todas") fetchData(page);
    else excepcionesRef.current?.refresh();
  };

  // El pipeline corre 1 vez al día: corregir el INCP de una fila ya cruzada tiene que poder
  // reprocesarse en el momento, o la plata no se mueve hasta la corrida del día siguiente.
  // En la pestaña "Excepciones" el badge lo pone su propio componente, así que aquí solo se
  // refresca (y se muestra) cuando la pestaña activa es "Todas".
  const { fireTrigger, reprocesoBadge, isRecalculando, marcaFila } = useReproceso(() => {
    if (tab === "todas") fetchData(page);
  });

  const getEdit = (row: CruceRow): EditState =>
    edits[row.matching_key] ?? {
      incp: row.incp ?? "",
      correo_2: row.correo_2 ?? "",
      nombre: row.nombre ?? "",
      metodo_de_pago: row.metodo_de_pago ?? "",
      ci: row.ci ?? "",
    };

  const setEdit = (row: CruceRow, field: keyof EditState, value: string) => {
    setEdits((prev) => ({
      ...prev,
      [row.matching_key]: { ...getEdit(row), ...prev[row.matching_key], [field]: value },
    }));
  };

  // Solo hay algo que guardar si el usuario cambió INCP o Correo(2): los otros tres campos
  // se reenvían tal cual vinieron. Sin este chequeo, un clic de más marcaría la fila como
  // `corregido_manual` sin haber corregido nada, y el pipeline dejaría de re-evaluarla.
  const hasEdit = (row: CruceRow) => {
    const edit = getEdit(row);
    return edit.incp !== (row.incp ?? "") || edit.correo_2 !== (row.correo_2 ?? "");
  };

  const handleSaveCruce = async (row: CruceRow) => {
    const edit = getEdit(row);
    setSavingKey(row.matching_key);
    setRowError((prev) => ({ ...prev, [row.matching_key]: "" }));
    setRowMessage((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const res = await fetch("/api/cruce/exceptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matching_key: row.matching_key,
          incp: edit.incp,
          correo_2: edit.correo_2,
          nombre: edit.nombre,
          metodo_de_pago: edit.metodo_de_pago,
          ci: edit.ci,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar");
      setData((prev) => prev.map((r) => r.matching_key === row.matching_key
        ? { ...r, incp: edit.incp, correo_2: edit.correo_2 }
        : r));
      setEdits((prev) => {
        const next = { ...prev };
        delete next[row.matching_key];
        return next;
      });
      setRowMessage((prev) => ({ ...prev, [row.matching_key]: "Guardado. Se aplica al terminar el recálculo." }));
      // Acción sobre UN pago → reproceso puntual (spec "Reproceso de un solo pago").
      fireTrigger(row.matching_key, { matchingKey: row.matching_key });
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [row.matching_key]: err instanceof Error ? err.message : "Error inesperado",
      }));
    } finally {
      setSavingKey(null);
    }
  };

  const fmt = (v: string | null) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  return (
    <div className="p-5 pb-8 space-y-4">
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-gray-900">Cruce de Cartera</h1>
          <span className="text-xs text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full font-medium">
            En construcción — INCP y CORREO(2) implementados, resto pendiente
          </span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <TriggerCruceButton onDone={handleTriggerDone} />
          <SegmentedControl
            value={tab}
            onChange={(v) => setTab(v as "todas" | "excepciones")}
            options={[
              { value: "todas", label: "Todas" },
              { value: "excepciones", label: "Excepciones" },
            ]}
          />
        </div>
      </div>

      {tab === "excepciones" ? (
        <CruceExcepcionesView ref={excepcionesRef} />
      ) : (
      <>
      {reprocesoBadge}
      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] px-6 py-4 space-y-3`}>
        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative w-80">
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por documento, código transacción, correo o VAL..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`w-full ${INPUT} rounded-full pl-9 pr-3.5`}
            />
          </div>
          <select
            value={paymentMethod}
            onChange={(e) => {
              setPaymentMethod(e.target.value);
              if (e.target.value !== "WOMPI%") setWompiTipo("");
              setPage(1);
            }}
            className={INPUT}
          >
            <option value="" className="text-gray-900">Todos los bancos</option>
            {methods.map((m) => (
              <option key={m.value} value={m.value} className="text-gray-900">{m.label}</option>
            ))}
          </select>
          <select
            value={wompiTipo}
            onChange={(e) => { setWompiTipo(e.target.value); setPage(1); }}
            disabled={paymentMethod !== "WOMPI%"}
            className={`${INPUT} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <option value="" className="text-gray-900">Todos (Wompi)</option>
            <option value="automatico" className="text-gray-900">Automáticos</option>
            <option value="manual" className="text-gray-900">Manuales</option>
          </select>
        </div>

        <div className="flex gap-6 flex-wrap text-sm text-gray-600 items-center">
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha Pago</span>
            <input type="date" value={payFrom} onChange={(e) => { setPayFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={payTo} onChange={(e) => { setPayTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha de Ingreso</span>
            <input type="date" value={regFrom} onChange={(e) => { setRegFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={regTo} onChange={(e) => { setRegTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sinCrucePreventiva}
              onChange={(e) => { setSinCrucePreventiva(e.target.checked); setPage(1); }}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
            />
            <span className="font-medium">Sin cruce con Cartera Preventiva</span>
          </label>
          {(search || paymentMethod || payFrom || payTo || regFrom || regTo || sinCrucePreventiva || wompiTipo) && (
            <button
              onClick={() => { setSearch(""); setPaymentMethod(""); setPayFrom(""); setPayTo(""); setRegFrom(""); setRegTo(""); setSinCrucePreventiva(false); setWompiTipo(""); setPage(1); }}
              className="text-red-500 hover:text-red-700 text-xs underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      <div className="px-1 flex items-center justify-between gap-3">
        <span className="text-sm text-gray-500">
          {loading ? "Cargando..." : `${total.toLocaleString("es-CO")} registros encontrados`}
        </span>

        <div className="flex items-center gap-2">
        <div ref={wompiDropdownRef} className="relative">
          <button
            onClick={() => setWompiDropdownOpen((o) => !o)}
            disabled={loading}
            className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3.5 py-1.5 rounded-full shadow-sm hover:bg-violet-700 hover:brightness-105 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Reporte WOMPI del día
            <svg className={`w-3 h-3 ml-0.5 transition-transform duration-200 ease-(--ease-spring) ${wompiDropdownOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {wompiDropdownOpen && (
            <div className="animate-pop-in origin-top-right absolute right-0 mt-1.5 w-44 bg-white border border-black/[0.06] rounded-xl shadow-[0_8px_24px_-8px_rgba(0,0,0,0.2)] z-50 overflow-hidden py-1">
              <button
                onClick={() => downloadWompiReport("excel")}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100"
              >
                Descargar Excel
              </button>
              <button
                onClick={() => downloadWompiReport("csv")}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100"
              >
                Descargar CSV
              </button>
            </div>
          )}
        </div>

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
                <th className="px-4 py-3 font-medium whitespace-nowrap">Documento</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fecha Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 1</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 2</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Correo</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Medio de Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Programa</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Teléfono</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Matrícula</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">INCP</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Correo(2)</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Nombre</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Método de Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">CI</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Cruce</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Acciones</th>
              </tr>
            </thead>
            <tbody key={page} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 16 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={16} className="text-center py-12 text-gray-400">No hay registros</td>
                </tr>
              ) : (
                data.map((row) => {
                  const edit    = getEdit(row);
                  const saving  = savingKey === row.matching_key;
                  const changed = hasEdit(row);
                  return (
                  <tr key={row.matching_key} className="hover:bg-gray-50/70 transition-colors duration-100 align-top">
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.identification)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.payment_date)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_1)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_2)}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{fmt(row.email)}</td>
                    <td className="px-4 py-2.5">
                      <span className="bg-brand-50 text-brand-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">
                        {fmt(row.payment_method)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.program)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.phone)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.payment_amount)}</td>
                    <td className="px-4 py-2.5">
                      <input
                        type="text"
                        value={edit.incp}
                        onChange={(e) => setEdit(row, "incp", e.target.value)}
                        disabled={saving}
                        title="INCP — corrígelo si el pago cruzó contra la inscripción equivocada"
                        className="w-28 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <input
                        type="text"
                        value={edit.correo_2}
                        onChange={(e) => setEdit(row, "correo_2", e.target.value)}
                        disabled={saving}
                        className="w-36 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                      />
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.nombre)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.metodo_de_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.ci)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cruce)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1 min-w-[150px]">
                        {changed && (
                          <button
                            onClick={() => handleSaveCruce(row)}
                            disabled={saving || isRecalculando(row.matching_key)}
                            className="text-xs px-2.5 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800 hover:brightness-105 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 disabled:active:scale-100"
                          >
                            {saving ? "Guardando..." : "Guardar corrección"}
                          </button>
                        )}
                        {marcaFila(row.matching_key)}
                        {rowMessage[row.matching_key] && (
                          <span className="text-[11px] text-green-700">{rowMessage[row.matching_key]}</span>
                        )}
                        {rowError[row.matching_key] && (
                          <span className="text-[11px] text-red-600">{rowError[row.matching_key]}</span>
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
      </>
      )}
    </div>
  );
}
