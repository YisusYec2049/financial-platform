"use client";

import { Fragment, useEffect, useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";

type PagoApartadoRow = {
  matching_key: string;
  tipo: string;
  origen: string;
  es_pago_unico: boolean | null;
  incp_resuelto: string | null;
  aparicion: string | null;
  fecha_marcada: string | null;
  fecha_ingreso: string | null;
  val: string | null;
  identification: string | null;
  payment_date: string | null;
  transaction_code_1: string | null;
  transaction_code_2: string | null;
  email: string | null;
  payment_method: string | null;
  program: string | null;
  phone: string | null;
  payment_amount: number | null;
  nota: string | null;
};

const TIPO_LABEL: Record<string, string> = {
  matricula: "Matrícula",
  cesantias: "Cesantías",
  pago_llave: "Pago por llave",
  cheque: "Cheque",
  otros: "Otros",
};

const TIPO_BADGE: Record<string, string> = {
  matricula: "bg-brand-50 text-brand-700",
  cesantias: "bg-emerald-50 text-emerald-700",
  pago_llave: "bg-amber-50 text-amber-700",
  cheque: "bg-rose-50 text-rose-700",
  otros: "bg-slate-100 text-slate-700",
};

export default function PagosApartadosView() {
  const [data, setData]             = useState<PagoApartadoRow[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useSessionState("pagos_apartados.search", "");
  const [tipo, setTipo]             = useSessionState("pagos_apartados.tipo", "");
  const [regFrom, setRegFrom]       = useSessionState("pagos_apartados.regFrom", "");
  const [regTo, setRegTo]           = useSessionState("pagos_apartados.regTo", "");
  const [fetchError, setFetchError] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [edits, setEdits]           = useState<Record<string, string>>({});
  const [rowError, setRowError]     = useState<Record<string, string>>({});
  const [rowMessage, setRowMessage] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey]   = useState<string | null>(null);
  const searchTimeout    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const tableContainerRef  = useRef<HTMLDivElement>(null);
  const dropdownRef        = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 100;

  const fetchData = useCallback(async (currentPage = 1) => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setLoading(true);
    setFetchError("");
    const params = new URLSearchParams();
    if (search)  params.set("search", search);
    if (tipo)    params.set("tipo", tipo);
    if (regFrom) params.set("reg_from", regFrom);
    if (regTo)   params.set("reg_to", regTo);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/pagos-apartados?${params}`, { signal });
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
  }, [search, tipo, regFrom, regTo]);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      fetchData(1);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search, tipo, regFrom, regTo, fetchData]);


  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handlePage = (p: number) => {
    setPage(p);
    fetchData(p);
  };

  // El pipeline corre 1 vez al día; una corrección manual aquí (INCP resuelto o
  // desmarcar) debe poder reprocesarse de inmediato en vez de esperar al cron (spec §6).
  // Best-effort: si el trigger falla (ej. TRIGGER_TOKEN no configurado en este entorno),
  // no bloquea ni revierte la corrección ya guardada.
  const fireTrigger = () => {
    fetch("/api/cruce/trigger", { method: "POST" }).catch(() => null);
  };

  const buildDownloadParams = () => {
    const params = new URLSearchParams();
    if (search)  params.set("search", search);
    if (tipo)    params.set("tipo", tipo);
    if (regFrom) params.set("reg_from", regFrom);
    if (regTo)   params.set("reg_to", regTo);
    return params;
  };

  const downloadExcel = async () => {
    setDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const res  = await fetch(`/api/pagos-apartados/download?${buildDownloadParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      const allRows = json.data || [];
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const ws = XLSX.utils.json_to_sheet(allRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Pagos Apartados");
      XLSX.writeFile(wb, `pagos_apartados_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
      const res  = await fetch(`/api/pagos-apartados/download?${buildDownloadParams()}`);
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
      a.download = `pagos_apartados_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveIncp = async (row: PagoApartadoRow) => {
    const incpResuelto = (edits[row.matching_key] ?? row.incp_resuelto ?? "").trim();
    setSavingKey(row.matching_key);
    setRowError((prev) => ({ ...prev, [row.matching_key]: "" }));
    setRowMessage((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const res  = await fetch("/api/pagos-apartados", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matching_key: row.matching_key, incp_resuelto: incpResuelto || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar");
      setData((prev) => prev.map((r) => r.matching_key === row.matching_key ? { ...r, incp_resuelto: incpResuelto || null } : r));
      setRowMessage((prev) => ({ ...prev, [row.matching_key]: "INCP guardado. Vuelve al proceso en el próximo cruce." }));
      fireTrigger();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.matching_key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setSavingKey(null);
    }
  };

  const handleDesmarcar = async (row: PagoApartadoRow) => {
    setSavingKey(row.matching_key);
    setRowError((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const res  = await fetch(`/api/pagos-apartados?matching_key=${encodeURIComponent(row.matching_key)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al desmarcar");
      setData((prev) => prev.filter((r) => r.matching_key !== row.matching_key));
      setTotal((prev) => Math.max(0, prev - 1));
      fireTrigger();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.matching_key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setSavingKey(null);
    }
  };

  const fmt = (v: string | null | undefined) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  return (
    <div className="p-5 pb-8 space-y-4">
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-gray-900">Pagos Apartados</h1>
          <span className="text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full font-medium">
            Matrícula, cesantías, pago por llave y cheques — fuera del cruce normal
          </span>
        </div>
      </div>

      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] px-6 py-4 space-y-3`}>
        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative w-80">
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por documento, código transacción, correo o motivo..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`w-full ${INPUT} rounded-full pl-9 pr-3.5`}
            />
          </div>
          <select
            value={tipo}
            onChange={(e) => { setTipo(e.target.value); setPage(1); }}
            className={INPUT}
          >
            <option value="" className="text-gray-900">Todos los tipos</option>
            <option value="matricula" className="text-gray-900">Matrícula</option>
            <option value="cesantias" className="text-gray-900">Cesantías</option>
            <option value="pago_llave" className="text-gray-900">Pago por llave</option>
            <option value="cheque" className="text-gray-900">Cheque</option>
            <option value="otros" className="text-gray-900">Otros</option>
          </select>
        </div>

        <div className="flex gap-6 flex-wrap text-sm text-gray-600 items-center">
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha de Ingreso</span>
            <input type="date" value={regFrom} onChange={(e) => { setRegFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={regTo} onChange={(e) => { setRegTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          {(search || tipo || regFrom || regTo) && (
            <button
              onClick={() => { setSearch(""); setTipo(""); setRegFrom(""); setRegTo(""); setPage(1); }}
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
              <button onClick={downloadExcel} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100">
                Descargar Excel
              </button>
              <button onClick={downloadCSV} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100">
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
                <th className="px-4 py-3 font-medium whitespace-nowrap">Documento</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Tipo</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Origen</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Pago Único</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Aparición</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fecha Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 1</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 2</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Correo</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Medio de Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Programa</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Teléfono</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Valor</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">INCP Resuelto</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Nota</th>
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
                  <td colSpan={16} className="text-center py-12 text-gray-400">No hay pagos apartados</td>
                </tr>
              ) : (
                data.map((row, i) => {
                  const isCheque = row.tipo === "cheque";
                  const saving   = savingKey === row.matching_key;
                  const prevDate = i > 0 ? data[i - 1].fecha_marcada : null;
                  const showGroupHeader = row.fecha_marcada !== prevDate;
                  return (
                    <Fragment key={row.matching_key}>
                      {showGroupHeader && (
                        <tr key={`group-${row.matching_key}`} className="bg-gray-50/60">
                          <td colSpan={16} className="px-4 py-1.5 text-xs font-medium text-gray-500">
                            Marcado el {fmt(row.fecha_marcada)}
                          </td>
                        </tr>
                      )}
                      <tr key={row.matching_key} className="hover:bg-gray-50/70 transition-colors duration-100 align-top">
                        <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.identification)}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${TIPO_BADGE[row.tipo] ?? "bg-gray-100 text-gray-700"}`}>
                            {isCheque && <span title="Cheque">🏦</span>}
                            {TIPO_LABEL[row.tipo] ?? row.tipo}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.origen)}</td>
                        <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{row.es_pago_unico ? "Sí" : "—"}</td>
                        <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{isCheque ? fmt(row.aparicion) : "—"}</td>
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
                          {isCheque ? (
                            <span className="text-gray-400">—</span>
                          ) : (
                            <input
                              type="text"
                              value={edits[row.matching_key] ?? row.incp_resuelto ?? ""}
                              onChange={(e) => setEdits((prev) => ({ ...prev, [row.matching_key]: e.target.value }))}
                              disabled={saving}
                              placeholder="NULL = sigue apartado"
                              className="w-32 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                            />
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 text-xs max-w-[200px]">{fmt(row.nota)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-col gap-1 min-w-[140px]">
                            {isCheque ? (
                              <span className="text-xs text-gray-400">Solo descarga — no vuelve al proceso</span>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleSaveIncp(row)}
                                  disabled={saving}
                                  className="text-xs px-2.5 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800 hover:brightness-105 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 disabled:active:scale-100"
                                >
                                  {saving ? "Guardando..." : "Guardar INCP"}
                                </button>
                                <button
                                  onClick={() => handleDesmarcar(row)}
                                  disabled={saving}
                                  className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 disabled:active:scale-100"
                                >
                                  Desmarcar
                                </button>
                              </>
                            )}
                            {rowMessage[row.matching_key] && (
                              <span className="text-xs text-green-700">{rowMessage[row.matching_key]}</span>
                            )}
                            {rowError[row.matching_key] && (
                              <span className="text-xs text-red-600">{rowError[row.matching_key]}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    </Fragment>
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
