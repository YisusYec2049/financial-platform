"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";
import { useReproceso } from "@/lib/useReproceso";

type Transaction = {
  id: string;
  registration_date: string;
  identification: string;
  payment_date: string;
  transaction_code_1: string;
  transaction_code_2: string;
  email: string;
  payment_method: string;
  program: string;
  phone: string;
  payment_amount: number;
  matching_key: string;
  incp: string;
  categoria: string;
  alerta_documento_repetido: boolean;
  alerta_posible_doble_cobro: boolean;
};

const CATEGORIA_LABEL: Record<string, string> = {
  normal: "Normal",
  matricula: "Matrícula",
  cesantias: "Cesantías",
  pago_llave: "Pago por llave",
  cheque: "Cheque",
  otros: "Otros",
};

const CATEGORIA_BADGE: Record<string, string> = {
  normal: "bg-gray-100 text-gray-600",
  matricula: "bg-brand-50 text-brand-700",
  cesantias: "bg-emerald-50 text-emerald-700",
  pago_llave: "bg-amber-50 text-amber-700",
  cheque: "bg-rose-50 text-rose-700",
  otros: "bg-slate-100 text-slate-700",
};

const PAGO_UNICO_THRESHOLD = 2_000_000;

export default function TransactionsView() {
  const [data, setData]                   = useState<Transaction[]>([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useSessionState("transactions.search", "");
  const [paymentMethod, setPaymentMethod] = useSessionState("transactions.paymentMethod", "");
  const [regFrom, setRegFrom]             = useSessionState("transactions.regFrom", "");
  const [regTo, setRegTo]                 = useSessionState("transactions.regTo", "");
  const [payFrom, setPayFrom]             = useSessionState("transactions.payFrom", "");
  const [payTo, setPayTo]                 = useSessionState("transactions.payTo", "");
  const [categoria, setCategoria]         = useSessionState("transactions.categoria", "");
  const [methods, setMethods]             = useState<{ label: string; value: string }[]>([]);
  const [lastUpdate, setLastUpdate]       = useState<Date | null>(null);
  const [fetchError, setFetchError]       = useState("");
  const [dropdownOpen, setDropdownOpen]   = useState(false);
  const [newRecords, setNewRecords]       = useState(false);
  const [docEdits, setDocEdits]           = useState<Record<string, string>>({});
  const [pagoUnicoChecked, setPagoUnicoChecked] = useState<Record<string, boolean>>({});
  const [rowSaving, setRowSaving]         = useState<string | null>(null);
  const [rowMessage, setRowMessage]       = useState<Record<string, string>>({});
  const [rowError, setRowError]           = useState<Record<string, string>>({});
  const [removePatternOffer, setRemovePatternOffer] = useState<Record<string, string>>({});
  const [otrosPanelOpen, setOtrosPanelOpen]     = useState<Record<string, boolean>>({});
  const [otrosNota, setOtrosNota]               = useState<Record<string, string>>({});
  const dropdownRef                       = useRef<HTMLDivElement>(null);
  const searchTimeout                     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef                = useRef<AbortController | null>(null);
  const tableContainerRef                 = useRef<HTMLDivElement>(null);

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
    if (regFrom)       params.set("reg_from", regFrom);
    if (regTo)         params.set("reg_to", regTo);
    if (payFrom)       params.set("pay_from", payFrom);
    if (payTo)         params.set("pay_to", payTo);
    if (categoria)     params.set("categoria", categoria);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/transactions?${params}`, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cargar datos");
      setData(json.data || []);
      setTotal(json.count || 0);
      setLastUpdate(new Date());
      setNewRecords(false);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setFetchError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }, [search, paymentMethod, regFrom, regTo, payFrom, payTo, categoria]);

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
  }, [search, paymentMethod, regFrom, regTo, payFrom, payTo, categoria, fetchData]);

  // Polling silencioso cada 30 segundos para detectar nuevos registros
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const params = new URLSearchParams();
        if (search)        params.set("search", search);
        if (paymentMethod) params.set("payment_method", paymentMethod);
        if (regFrom)       params.set("reg_from", regFrom);
        if (regTo)         params.set("reg_to", regTo);
        if (payFrom)       params.set("pay_from", payFrom);
        if (payTo)         params.set("pay_to", payTo);
        if (categoria)     params.set("categoria", categoria);
        params.set("page", "1");

        const res  = await fetch(`/api/transactions?${params}`);
        const json = await res.json();
        if (res.ok && json.count > total) setNewRecords(true);
      } catch {
        // falla silenciosa, no interrumpir al usuario
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [search, paymentMethod, regFrom, regTo, payFrom, payTo, categoria, total]);


  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleLogout = async () => {
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  };


  const handlePage = (p: number) => {
    setPage(p);
    fetchData(p);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const downloadExcel = async () => {
    setLoading(true);
    setFetchError("");
    const params = new URLSearchParams();
    if (search)        params.set("search", search);
    if (paymentMethod) params.set("payment_method", paymentMethod);
    if (regFrom)       params.set("reg_from", regFrom);
    if (regTo)         params.set("reg_to", regTo);
    if (payFrom)       params.set("pay_from", payFrom);
    if (payTo)         params.set("pay_to", payTo);
    if (categoria)     params.set("categoria", categoria);

    try {
      const res  = await fetch(`/api/transactions/download?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      const allRows = json.data || [];
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros de fecha para acotar la búsqueda.");
      }
      const ws = XLSX.utils.json_to_sheet(allRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Transacciones");
      XLSX.writeFile(wb, `transacciones_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
    const params = new URLSearchParams();
    if (search)        params.set("search", search);
    if (paymentMethod) params.set("payment_method", paymentMethod);
    if (regFrom)       params.set("reg_from", regFrom);
    if (regTo)         params.set("reg_to", regTo);
    if (payFrom)       params.set("pay_from", payFrom);
    if (payTo)         params.set("pay_to", payTo);
    if (categoria)     params.set("categoria", categoria);

    try {
      const res  = await fetch(`/api/transactions/download?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros de fecha para acotar la búsqueda.");
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
      a.download = `transacciones_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  };

  // El pipeline corre 1 vez al día; una acción de confirmación aquí (marcar
  // matrícula/cesantías, corregir el documento) debe poder reprocesarse de
  // inmediato en vez de esperar al cron (spec §6). Best-effort: si falla, no
  // bloquea ni revierte lo ya guardado.
  const { fireTrigger, reprocesoBadge, marcaFila } = useReproceso(() => fetchData(page));

  const handleMarcar = async (row: Transaction, tipo: "matricula" | "cesantias" | "otros") => {
    const nota = tipo === "otros" ? (otrosNota[row.matching_key] ?? "").trim() : undefined;
    if (tipo === "otros" && !nota) {
      setRowError((prev) => ({ ...prev, [row.matching_key]: "El motivo es requerido" }));
      return;
    }
    setRowSaving(row.matching_key);
    setRowError((prev) => ({ ...prev, [row.matching_key]: "" }));
    setRowMessage((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const res  = await fetch("/api/transactions/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matching_key: row.matching_key,
          tipo,
          es_pago_unico: tipo === "matricula" ? !!pagoUnicoChecked[row.matching_key] : undefined,
          nota,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al marcar");
      setData((prev) => prev.map((r) => r.matching_key === row.matching_key ? { ...r, categoria: tipo } : r));
      setRowMessage((prev) => ({ ...prev, [row.matching_key]: "Marcado. Sale del proceso en el próximo cruce." }));
      setOtrosPanelOpen((prev) => ({ ...prev, [row.matching_key]: false }));
      fireTrigger(row.matching_key);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.matching_key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleDesmarcar = async (row: Transaction) => {
    setRowSaving(row.matching_key);
    setRowError((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const wasCesantias = row.categoria === "cesantias";
      const res  = await fetch(`/api/pagos-apartados?matching_key=${encodeURIComponent(row.matching_key)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al desmarcar");
      setData((prev) => prev.map((r) => r.matching_key === row.matching_key ? { ...r, categoria: "normal" } : r));
      setRowMessage((prev) => ({ ...prev, [row.matching_key]: "Desmarcado. Vuelve al flujo normal." }));
      if (wasCesantias && row.transaction_code_1) {
        setRemovePatternOffer((prev) => ({ ...prev, [row.matching_key]: row.transaction_code_1 }));
      }
      fireTrigger(row.matching_key);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.matching_key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleRemovePattern = async (matchingKey: string, descripcion: string) => {
    try {
      await fetch(`/api/cesantias-patrones?descripcion=${encodeURIComponent(descripcion)}`, { method: "DELETE" });
      setRowMessage((prev) => ({ ...prev, [matchingKey]: "Desmarcado. Patrón aprendido eliminado." }));
    } catch {
      // best-effort
    } finally {
      setRemovePatternOffer((prev) => {
        const next = { ...prev };
        delete next[matchingKey];
        return next;
      });
    }
  };

  const handleSaveDocumento = async (row: Transaction) => {
    const nuevo = (docEdits[row.matching_key] ?? row.identification).trim();
    if (!nuevo || nuevo === row.identification) return;
    setRowSaving(row.matching_key);
    setRowError((prev) => ({ ...prev, [row.matching_key]: "" }));
    setRowMessage((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const res  = await fetch("/api/transactions/correct-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matching_key: row.matching_key, documento_corregido: nuevo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al corregir el documento");
      setData((prev) => prev.map((r) => r.matching_key === row.matching_key ? { ...r, identification: nuevo } : r));
      setDocEdits((prev) => {
        const next = { ...prev };
        delete next[row.matching_key];
        return next;
      });
      setRowMessage((prev) => ({ ...prev, [row.matching_key]: "Documento corregido. Se recuerda para pagos futuros con el mismo documento." }));
      fireTrigger(row.matching_key);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.matching_key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const fmt = (v: string | null) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  return (
    <div className="p-5 pb-8 space-y-4">
      {reprocesoBadge}
      {/* Header */}
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-gray-900">Transacciones consolidadas</h1>
          <span className="flex items-center gap-1.5 bg-green-50 text-green-700 text-xs font-medium px-2.5 py-1 rounded-full">
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
            En vivo
          </span>
          {lastUpdate && (
            <span className="text-xs text-gray-400">
              Actualizado: {lastUpdate.toLocaleTimeString("es-CO")}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {/* Cruce de Cartera */}
          <Link
            href="/cruce"
            className="flex items-center gap-1.5 border border-black/10 text-brand-700 text-sm px-3.5 py-1.5 rounded-full hover:bg-brand-50 hover:-translate-y-px active:scale-95 active:translate-y-0 transition-all duration-200 ease-(--ease-spring)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
            </svg>
            Cruce de Cartera
          </Link>

          {/* Dropdown de descarga */}
          <div ref={dropdownRef} className="relative">
            <button
              onClick={() => setDropdownOpen((o) => !o)}
              disabled={loading}
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
                  onClick={() => { setDropdownOpen(false); downloadExcel(); }}
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

          {/* Cerrar sesión */}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 bg-red-500 text-white text-sm px-3.5 py-1.5 rounded-full shadow-sm hover:bg-red-600 hover:brightness-105 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Cerrar sesión
          </button>
        </div>
      </div>

      {/* Filtros */}
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
            onChange={(e) => { setPaymentMethod(e.target.value); setPage(1); }}
            className={INPUT}
          >
            <option value="" className="text-gray-900">Todos los medios</option>
            {methods.map((m) => (
              <option key={m.value} value={m.value} className="text-gray-900">{m.label}</option>
            ))}
          </select>
          <select
            value={categoria}
            onChange={(e) => { setCategoria(e.target.value); setPage(1); }}
            className={INPUT}
          >
            <option value="" className="text-gray-900">Todas las categorías</option>
            <option value="normal" className="text-gray-900">Normal</option>
            <option value="matricula" className="text-gray-900">Matrícula</option>
            <option value="cesantias" className="text-gray-900">Cesantías</option>
            <option value="pago_llave" className="text-gray-900">Pago por llave</option>
            <option value="cheque" className="text-gray-900">Cheque</option>
            <option value="otros" className="text-gray-900">Otros</option>
          </select>
        </div>

        <div className="flex gap-6 flex-wrap text-sm text-gray-600 items-center">
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha Registro</span>
            <input type="date" value={regFrom} onChange={(e) => { setRegFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={regTo} onChange={(e) => { setRegTo(e.target.value); setPage(1); }}
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
          {(search || paymentMethod || regFrom || regTo || payFrom || payTo || categoria) && (
            <button
              onClick={() => { setSearch(""); setPaymentMethod(""); setRegFrom(""); setRegTo(""); setPayFrom(""); setPayTo(""); setCategoria(""); setPage(1); }}
              className="text-red-500 hover:text-red-700 text-xs underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {/* Conteo */}
      <div className="px-1 text-sm text-gray-500">
        {loading ? "Cargando..." : `${total.toLocaleString("es-CO")} registros encontrados`}
      </div>

      {fetchError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2">
          {fetchError}
        </div>
      )}

      {newRecords && (
        <button
          onClick={() => fetchData(1)}
          className="animate-slide-down w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 hover:brightness-105 active:scale-[0.98] text-white text-sm font-medium px-4 py-2 rounded-full shadow-sm transition-all duration-200 ease-(--ease-spring)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Hay nuevos registros — clic para actualizar
        </button>
      )}

      {/* Tabla */}
      <div className={`${PANEL} animate-fade-in [animation-delay:100ms] overflow-hidden`}>
        <div ref={tableContainerRef} className="overflow-auto max-h-[65vh]">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-50 text-gray-500 text-left border-b border-black/[0.06]">
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fecha Registro</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Documento</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fecha Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 1</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 2</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Correo</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Programa</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Teléfono</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Valor</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Medio de Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Categoría</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Acciones</th>
              </tr>
            </thead>
            <tbody key={page} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 12 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={12} className="text-center py-12 text-gray-400">No hay registros</td>
                </tr>
              ) : (
                data.map((row) => {
                  const saving = rowSaving === row.matching_key;
                  const isNormal = row.categoria === "normal";
                  const patternOffer = removePatternOffer[row.matching_key];
                  const docValue = docEdits[row.matching_key] ?? row.identification;
                  const docChanged = docValue.trim() !== "" && docValue.trim() !== row.identification;
                  return (
                  <tr key={row.id} className="hover:bg-gray-50/70 transition-colors duration-100 align-top">
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.registration_date)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        {row.alerta_posible_doble_cobro && (
                          <span title="Mismo documento, mismo día y mismo monto: posible doble cobro" className="text-red-600 text-xs">⚠️</span>
                        )}
                        {!row.alerta_posible_doble_cobro && row.alerta_documento_repetido && (
                          <span title="Este documento tiene más de un pago el mismo día" className="text-amber-600 text-xs">⚠️</span>
                        )}
                        {row.matching_key?.endsWith("(duplicado)") && (
                          <span title="Llave duplicada: Bancolombia generó la misma llave para dos pagos el mismo día" className="text-purple-600 text-xs">⚠️</span>
                        )}
                        <input
                          type="text"
                          value={docValue}
                          onChange={(e) => setDocEdits((prev) => ({ ...prev, [row.matching_key]: e.target.value }))}
                          disabled={saving}
                          className="w-28 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                        {docChanged && (
                          <button
                            onClick={() => handleSaveDocumento(row)}
                            disabled={saving}
                            title="Guardar corrección de documento"
                            className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            ✓
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.payment_date)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_1)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_2)}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{fmt(row.email)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.program)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.phone)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        {fmtMonto(row.payment_amount)}
                        {row.payment_amount > PAGO_UNICO_THRESHOLD && isNormal && (
                          <span title="Monto alto: posible pago único / matrícula, solo sugerencia" className="text-brand-600 text-xs">💡</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="bg-brand-50 text-brand-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">
                        {fmt(row.payment_method)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${CATEGORIA_BADGE[row.categoria] ?? "bg-gray-100 text-gray-600"}`}>
                        {CATEGORIA_LABEL[row.categoria] ?? row.categoria}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1 min-w-[150px]">
                        {isNormal ? (
                          <>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => handleMarcar(row, "matricula")}
                                disabled={saving}
                                className="text-xs px-2 py-1 rounded-lg border border-brand-300 text-brand-700 hover:bg-brand-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                              >
                                Matrícula
                              </button>
                              <label className="flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={!!pagoUnicoChecked[row.matching_key]}
                                  onChange={(e) => setPagoUnicoChecked((prev) => ({ ...prev, [row.matching_key]: e.target.checked }))}
                                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
                                />
                                único
                              </label>
                            </div>
                            <button
                              onClick={() => handleMarcar(row, "cesantias")}
                              disabled={saving}
                              className="text-xs px-2 py-1 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              Cesantías
                            </button>
                            <button
                              onClick={() => setOtrosPanelOpen((prev) => ({ ...prev, [row.matching_key]: !prev[row.matching_key] }))}
                              disabled={saving}
                              className="text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              Otros
                            </button>
                            {otrosPanelOpen[row.matching_key] && (
                              <div className="animate-fade-in bg-slate-50 border border-slate-200 rounded-lg p-2 space-y-1.5 w-56">
                                <label className="block text-[11px] text-gray-500">Motivo</label>
                                <input
                                  type="text"
                                  value={otrosNota[row.matching_key] ?? ""}
                                  onChange={(e) => setOtrosNota((prev) => ({ ...prev, [row.matching_key]: e.target.value }))}
                                  disabled={saving}
                                  placeholder="¿Por qué se aparta?"
                                  className="w-full border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                                />
                                <button
                                  onClick={() => handleMarcar(row, "otros")}
                                  disabled={saving}
                                  className="w-full text-xs px-2 py-1.5 rounded-lg bg-slate-700 text-white hover:bg-slate-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                                >
                                  {saving ? "Guardando..." : "Confirmar"}
                                </button>
                              </div>
                            )}
                          </>
                        ) : (row.categoria === "matricula" || row.categoria === "cesantias" || row.categoria === "otros") ? (
                          <button
                            onClick={() => handleDesmarcar(row)}
                            disabled={saving}
                            className="text-xs px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            Desmarcar
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">Automático</span>
                        )}
                        {patternOffer && (
                          <div className="animate-fade-in bg-amber-50/70 border border-amber-200/80 rounded-lg p-1.5 space-y-1">
                            <p className="text-[11px] text-amber-800">¿Quitar también el patrón aprendido?</p>
                            <div className="flex gap-1">
                              <button
                                onClick={() => handleRemovePattern(row.matching_key, patternOffer)}
                                className="text-[11px] px-1.5 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
                              >
                                Sí
                              </button>
                              <button
                                onClick={() => setRemovePatternOffer((prev) => { const n = { ...prev }; delete n[row.matching_key]; return n; })}
                                className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                              >
                                No
                              </button>
                            </div>
                          </div>
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

        {/* Paginación */}
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
