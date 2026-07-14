"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSidebar } from "@/components/SidebarContext";
import { useSessionState } from "@/lib/useSessionState";

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
  diferencia: number | null;
};

export default function CarteraPreventivaView() {
  const { width: sidebarWidth }         = useSidebar();
  const [data, setData]                 = useState<CarteraPreventivaRow[]>([]);
  const [total, setTotal]               = useState(0);
  const [page, setPage]                 = useState(1);
  const [loading, setLoading]           = useState(false);
  const [search, setSearch]             = useSessionState("cartera_preventiva.search", "");
  const [estado, setEstado]             = useSessionState("cartera_preventiva.estado", "todas");
  const [vencFrom, setVencFrom]         = useSessionState("cartera_preventiva.vencFrom", "");
  const [vencTo, setVencTo]             = useSessionState("cartera_preventiva.vencTo", "");
  const [fetchError, setFetchError]     = useState("");
  const [tableWidth, setTableWidth]     = useState(0);
  const searchTimeout                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef              = useRef<AbortController | null>(null);
  const tableContainerRef               = useRef<HTMLDivElement>(null);
  const fixedScrollRef                  = useRef<HTMLDivElement>(null);

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
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/cartera-preventiva?${params}`, { signal });
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
  }, [search, estado, vencFrom, vencTo]);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      fetchData(1);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search, estado, vencFrom, vencTo, fetchData]);

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

  const paymentBadge = (row: CarteraPreventivaRow) => {
    if (!row.fecha_pago) {
      return <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Sin pago identificado</span>;
    }
    if (row.diferencia === 0) {
      return <span className="bg-emerald-50 text-emerald-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Pagada completa</span>;
    }
    if (row.diferencia != null && row.diferencia < 0) {
      return <span className="bg-orange-50 text-orange-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Saldo: {fmtMonto(Math.abs(row.diferencia))}</span>;
    }
    return <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">—</span>;
  };

  const rowTint = (row: CarteraPreventivaRow) => {
    if (!row.fecha_pago) return "";
    if (row.diferencia === 0) return "bg-emerald-50/30";
    if (row.diferencia != null && row.diferencia < 0) return "bg-orange-50/30";
    return "";
  };

  return (
    <div className="p-5 pb-8 space-y-4">
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <h1 className="text-lg font-semibold text-gray-900">Cartera Preventiva</h1>
      </div>

      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] px-6 py-4 space-y-3`}>
        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative w-80">
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por cliente o matrícula..."
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
          {(search || estado !== "todas" || vencFrom || vencTo) && (
            <button
              onClick={() => { setSearch(""); setEstado("todas"); setVencFrom(""); setVencTo(""); setPage(1); }}
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
                <th className="px-4 py-3 font-medium whitespace-nowrap">Diferencia</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Cruce Access</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Estado</th>
              </tr>
            </thead>
            <tbody key={page} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 19 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={19} className="text-center py-12 text-gray-400">No hay registros</td>
                </tr>
              ) : (
                data.map((row) => (
                  <tr key={row.id} className={`hover:bg-gray-50/70 transition-colors duration-100 ${rowTint(row)}`}>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.llave)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.sistema_financiero)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.inscrip)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cliente)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.moneda)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.fecha_vencimiento)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_cuota)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_a_cobrar)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.programa)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.fecha_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.medio_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_1)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_2)}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{fmt(row.correo_elec)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.diferencia)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cruce_access)}</td>
                    <td className="px-4 py-2.5">{paymentBadge(row)}</td>
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
    </div>
  );
}
