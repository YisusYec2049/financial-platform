"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSidebar } from "@/components/SidebarContext";

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
  const { width: sidebarWidth }     = useSidebar();
  const [data, setData]             = useState<CruceRow[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState("");
  const [fetchError, setFetchError] = useState("");
  const [tableWidth, setTableWidth] = useState(0);
  const searchTimeout               = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef          = useRef<AbortController | null>(null);
  const tableContainerRef           = useRef<HTMLDivElement>(null);
  const fixedScrollRef              = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 100;

  const fetchData = useCallback(async (currentPage = 1) => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setLoading(true);
    setFetchError("");
    const params = new URLSearchParams();
    if (search) params.set("search", search);
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
  }, [search]);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      fetchData(1);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search, fetchData]);

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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">Cruce de Cartera</h1>
          <span className="text-xs text-amber-700 bg-amber-100 px-2.5 py-1 rounded-full font-medium">
            En construcción — INCP y CORREO(2) implementados, resto pendiente
          </span>
        </div>
      </div>

      <div className="bg-white border-b px-6 py-3">
        <div className="relative w-80">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            placeholder="Buscar por documento, código transacción o correo..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>
      </div>

      <div className="px-6 py-2 text-sm text-gray-500">
        {loading ? "Cargando..." : `${total.toLocaleString("es-CO")} registros encontrados`}
      </div>

      {fetchError && (
        <div className="mx-6 mb-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {fetchError}
        </div>
      )}

      <div ref={tableContainerRef} className="px-6 pb-6 overflow-x-auto">
        <table className="w-full text-sm border-collapse bg-white rounded-lg shadow-sm overflow-hidden">
          <thead>
            <tr className="bg-gray-100 text-gray-600 text-left">
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
          <tbody>
            {loading && data.length === 0 ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-t border-gray-100">
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
                <tr key={row.matching_key} className="border-t border-gray-100 hover:bg-gray-50 transition-colors duration-100">
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.identification)}</td>
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.payment_date)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_1)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_2)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{fmt(row.email)}</td>
                  <td className="px-4 py-2.5">
                    <span className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">
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

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 text-sm text-gray-600">
            <span>Página {page} de {totalPages}</span>
            <div className="flex gap-1">
              <button onClick={() => handlePage(1)} disabled={page === 1}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">«</button>
              <button onClick={() => handlePage(page - 1)} disabled={page === 1}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">‹</button>
              {[...Array(Math.min(5, totalPages))].map((_, i) => {
                const p = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
                return (
                  <button key={p} onClick={() => handlePage(p)}
                    className={`px-2 py-1 border rounded hover:bg-gray-100 active:scale-95 transition-all duration-150 ${p === page ? "bg-gray-900 text-white border-gray-900" : ""}`}>
                    {p}
                  </button>
                );
              })}
              <button onClick={() => handlePage(page + 1)} disabled={page === totalPages}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">›</button>
              <button onClick={() => handlePage(totalPages)} disabled={page === totalPages}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">»</button>
            </div>
          </div>
        )}
      </div>

      <div
        ref={fixedScrollRef}
        className="fixed bottom-0 right-0 z-50 bg-white border-t border-gray-200"
        style={{ left: sidebarWidth, overflowX: "scroll", overflowY: "hidden", height: 20 }}
      >
        <div style={{ width: tableWidth, height: 1 }} />
      </div>
      <div style={{ height: 20 }} />
    </div>
  );
}
