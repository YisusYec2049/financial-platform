"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";

// Las mismas columnas de Cartera Preventiva; el archivo agrega carga_id/fecha_archivo.
type HistoricoRow = {
  id: number;
  llave: string;
  inscrip: string;
  cliente: string;
  correo_elec: string | null;
  codigo_transaccion_1: string | null;
  codigo_transaccion_2: string | null;
  fecha_vencimiento: string;
  valor_cuota: number;
  valor_a_cobrar: number;
  programa: string;
  cruce_access: string;
  sistema_financiero: string | null;
  moneda: string | null;
  pago: string | null;
  fecha_pago: string | null;
  medio_pago: string | null;
  valor_pago: number | null;
  pago_confirmado: number | null;
  diferencia: number | null;
  fecha_cruce: string | null;
  notificacion: string | null;
};

type CarteraOpcion = {
  id: string;
  tipo: "viva" | "archivo";
  desde: string | null;
  hasta: string | null;
  cuotas: number;
  cuotas_con_cruce: number | null;
  cruce_desde: string | null;
  cruce_hasta: string | null;
};

const CARTERA_VIVA = "viva";
const COLUMNAS = 21;

// Las fechas de la base son instantes con zona (`…-0500` en carga_id, `…+00:00` en
// fecha_archivo), así que se formatean en hora de Colombia: dejarlo al navegador haría
// que una carga de las 8 p.m. se viera un día corrida.
const fmtDia = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric",
  }).format(d);
};

const etiquetaCartera = (c: CarteraOpcion) => {
  const cuotas = `${c.cuotas.toLocaleString("es-CO")} cuotas`;
  if (c.tipo === "viva") {
    return c.desde
      ? `Cartera actual — desde el ${fmtDia(c.desde)} · ${cuotas}`
      : `Cartera actual · ${cuotas}`;
  }
  // "Cartera del 24/08 al 26/08/2026": del día de carga al día en que se archivó.
  const desde = fmtDia(c.desde).slice(0, 5);
  return `Cartera del ${desde} al ${fmtDia(c.hasta)} · ${cuotas}`;
};

export default function HistoricoCarterasView() {
  const [carteras, setCarteras]     = useState<CarteraOpcion[]>([]);
  const [data, setData]             = useState<HistoricoRow[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [cartera, setCartera]       = useSessionState("historico_carteras.cartera", CARTERA_VIVA);
  const [search, setSearch]         = useSessionState("historico_carteras.search", "");
  const [estado, setEstado]         = useSessionState("historico_carteras.estado", "todas");
  const [cruceFrom, setCruceFrom]   = useSessionState("historico_carteras.cruceFrom", "");
  const [cruceTo, setCruceTo]       = useSessionState("historico_carteras.cruceTo", "");
  const searchTimeout      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const dropdownRef        = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 100;

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch("/api/historico-carteras/carteras");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al cargar las carteras");
        setCarteras(json.data || []);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : "Error inesperado");
      }
    })();
  }, []);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("cartera", cartera);
    if (search)    params.set("search", search);
    if (estado !== "todas") params.set("estado", estado);
    if (cruceFrom) params.set("cruce_from", cruceFrom);
    if (cruceTo)   params.set("cruce_to", cruceTo);
    return params;
  }, [cartera, search, estado, cruceFrom, cruceTo]);

  const fetchData = useCallback(async (currentPage = 1) => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setLoading(true);
    setFetchError("");
    const params = buildParams();
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/historico-carteras?${params}`, { signal });
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
  }, [buildParams]);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      fetchData(1);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [fetchData]);

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
  const handlePage = (p: number) => { setPage(p); fetchData(p); };

  const carteraActual = carteras.find((c) => c.id === cartera);
  const nombreArchivo = cartera === CARTERA_VIVA
    ? "cartera_actual"
    : `cartera_${fmtDia(carteraActual?.desde ?? null).replace(/\//g, "-")}`;

  const descargar = async (formato: "xlsx" | "csv") => {
    setDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const res  = await fetch(`/api/historico-carteras/download?${buildParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const rows: Record<string, unknown>[] = json.data || [];
      if (rows.length === 0) return;
      const fecha = new Date().toISOString().slice(0, 10);

      if (formato === "xlsx") {
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Histórico Cartera");
        XLSX.writeFile(wb, `historico_${nombreArchivo}_${fecha}.xlsx`);
        return;
      }

      const headers  = Object.keys(rows[0]);
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
      a.download = `historico_${nombreArchivo}_${fecha}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  };

  const fmt = (v: string | null) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  // El mismo criterio que el filtro y que Cartera Preventiva, en texto plano: acá no van
  // badges. Un badge de la pantalla viva invita a una acción que en el histórico no
  // existe, y `notificacion`/`diferencia` describen cómo se veía la cuota el día que se
  // archivó, no cómo está hoy.
  const estadoTexto = (row: HistoricoRow) => {
    if (row.pago_confirmado != null) return "Cerrada";
    if (row.fecha_pago) return "Resuelta";
    return "Pendiente";
  };

  const hayFiltros = search || estado !== "todas" || cruceFrom || cruceTo;

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  return (
    <div className="p-5 pb-8 space-y-4">
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-gray-900">Histórico Carteras</h1>
          <span className="text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full font-medium">
            Solo lectura — la traza de cada cartera, incluida la actual
          </span>
        </div>
      </div>

      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] px-6 py-4 space-y-3`}>
        <div className="flex gap-3 flex-wrap items-center">
          <select
            value={cartera}
            onChange={(e) => { setCartera(e.target.value); setPage(1); }}
            className={`${INPUT} min-w-[22rem] font-medium`}
          >
            {carteras.length === 0 && <option value={CARTERA_VIVA}>Cargando carteras...</option>}
            {carteras.map((c) => (
              <option key={c.id} value={c.id} className="text-gray-900">{etiquetaCartera(c)}</option>
            ))}
          </select>

          <div className="relative w-80">
            <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por cliente, documento, inscripción, código o llave..."
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
            <option value="todas" className="text-gray-900">Todos los estados</option>
            <option value="pendiente" className="text-gray-900">Pendiente</option>
            <option value="resuelta" className="text-gray-900">Resuelta</option>
            <option value="cerrada" className="text-gray-900">Cerrada</option>
          </select>
        </div>

        <div className="flex gap-6 flex-wrap text-sm text-gray-600 items-center">
          <div className="flex items-center gap-2">
            <span className="font-medium">Día del Cruce</span>
            <input type="date" value={cruceFrom} onChange={(e) => { setCruceFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={cruceTo} onChange={(e) => { setCruceTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          {carteraActual?.cruce_desde && (
            <span className="text-xs text-gray-500">
              Esta cartera cruzó del {carteraActual.cruce_desde} al {carteraActual.cruce_hasta}
              {carteraActual.cuotas_con_cruce != null && ` · ${carteraActual.cuotas_con_cruce.toLocaleString("es-CO")} cuotas con cruce`}
            </span>
          )}
          {hayFiltros && (
            <button
              onClick={() => { setSearch(""); setEstado("todas"); setCruceFrom(""); setCruceTo(""); setPage(1); }}
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
              <button onClick={() => descargar("xlsx")} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100">
                Descargar Excel
              </button>
              <button onClick={() => descargar("csv")} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-100">
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
        <div className="overflow-auto max-h-[65vh]">
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
                <th className="px-4 py-3 font-medium whitespace-nowrap bg-brand-50/60 text-brand-700">Fecha Cruce</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Medio de Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Valor Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 1</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 2</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Correo Electrónico</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Notificación</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Diferencia</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Documento</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Estado</th>
              </tr>
            </thead>
            <tbody key={`${cartera}-${page}`} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: COLUMNAS }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNAS} className="text-center py-12 text-gray-400">
                    No hay cuotas en esta cartera con los filtros aplicados
                  </td>
                </tr>
              ) : (
                data.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50/70 transition-colors duration-100 align-top">
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.llave)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.sistema_financiero)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.inscrip)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.cliente)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.moneda)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.fecha_vencimiento)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_cuota)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_a_cobrar)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.programa)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.fecha_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-800 whitespace-nowrap bg-brand-50/40 font-medium">{fmt(row.fecha_cruce)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.medio_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_1)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_2)}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{fmt(row.correo_elec)}</td>
                    <td className="px-4 py-2.5 text-gray-600 text-xs max-w-[220px]">{fmt(row.notificacion)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.diferencia)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cruce_access)}</td>
                    <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{estadoTexto(row)}</td>
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
    </div>
  );
}
