"use client";

import { useEffect, useState, useCallback, useRef, useLayoutEffect } from "react";
import { useSidebar } from "@/components/SidebarContext";
import CruceExcepcionesView from "@/components/CruceExcepcionesView";

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
};

export default function CruceView() {
  const { width: sidebarWidth }           = useSidebar();
  const [tab, setTab]                     = useState<"todas" | "excepciones">("todas");
  const [data, setData]                   = useState<CruceRow[]>([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [payFrom, setPayFrom]             = useState("");
  const [payTo, setPayTo]                 = useState("");
  const [methods, setMethods]             = useState<{ label: string; value: string }[]>([]);
  const [fetchError, setFetchError]       = useState("");
  const [tableWidth, setTableWidth]       = useState(0);
  const searchTimeout                     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef                = useRef<AbortController | null>(null);
  const tableContainerRef                 = useRef<HTMLDivElement>(null);
  const fixedScrollRef                    = useRef<HTMLDivElement>(null);

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
  }, [search, paymentMethod, payFrom, payTo]);

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
  }, [search, paymentMethod, payFrom, payTo, fetchData]);

  useEffect(() => {
    const tableEl = tableContainerRef.current;
    const fixedEl = fixedScrollRef.current;
    if (!tableEl || !fixedEl) return;

    let ticking = false;
    const onTable = () => { if (!ticking) { ticking = true; fixedEl.scrollLeft = tableEl.scrollLeft; ticking = false; } };
    const onFixed = () => { if (!ticking) { ticking = true; tableEl.scrollLeft = fixedEl.scrollLeft; ticking = false; } };

    tableEl.addEventListener("scroll", onTable, { passive: true });
    fixedEl.addEventListener("scroll", onFixed, { passive: true });
    return () => {
      tableEl.removeEventListener("scroll", onTable);
      fixedEl.removeEventListener("scroll", onFixed);
    };
  }, []);

  useEffect(() => {
    const tableEl = tableContainerRef.current;
    if (!tableEl) return;
    const update = () => {
      const table = tableEl.querySelector("table");
      if (table) setTableWidth(table.scrollWidth);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [data]);

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

  return (
    <div className="p-5 pb-8 space-y-4">
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-gray-900">Cruce de Cartera</h1>
          <span className="text-xs text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full font-medium">
            En construcción — INCP y CORREO(2) implementados, resto pendiente
          </span>
        </div>

        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as "todas" | "excepciones")}
          options={[
            { value: "todas", label: "Todas" },
            { value: "excepciones", label: "Excepciones" },
          ]}
        />
      </div>

      {tab === "excepciones" ? (
        <CruceExcepcionesView />
      ) : (
      <>
      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] px-6 py-4 space-y-3`}>
        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative w-80">
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por documento, código transacción o correo..."
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
            <option value="" className="text-gray-900">Todos los bancos</option>
            {methods.map((m) => (
              <option key={m.value} value={m.value} className="text-gray-900">{m.label}</option>
            ))}
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
          {(search || paymentMethod || payFrom || payTo) && (
            <button
              onClick={() => { setSearch(""); setPaymentMethod(""); setPayFrom(""); setPayTo(""); setPage(1); }}
              className="text-red-500 hover:text-red-700 text-xs underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      <div className="px-1 text-sm text-gray-500">
        {loading ? "Cargando..." : `${total.toLocaleString("es-CO")} registros encontrados`}
      </div>

      {fetchError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2">
          {fetchError}
        </div>
      )}

      <div className={`${PANEL} animate-fade-in [animation-delay:100ms] overflow-hidden`}>
        <div ref={tableContainerRef} className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50/80 text-gray-500 text-left">
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
              </tr>
            </thead>
            <tbody key={page} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 11 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-gray-400">No hay registros</td>
                </tr>
              ) : (
                data.map((row) => (
                  <tr key={row.matching_key} className="hover:bg-gray-50/70 transition-colors duration-100">
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
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.incp)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.correo_2)}</td>
                  </tr>
                ))
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

      <div
        ref={fixedScrollRef}
        className="fixed bottom-0 right-0 z-50 bg-white border-t border-black/[0.06] transition-all duration-300 ease-in-out"
        style={{ left: sidebarWidth, overflowX: "scroll", overflowY: "hidden", height: 20 }}
      >
        <div style={{ width: tableWidth, height: 1 }} />
      </div>
      </>
      )}
    </div>
  );
}
