"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

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
};

export default function TransactionsView() {
  const [data, setData]                   = useState<Transaction[]>([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [regFrom, setRegFrom]             = useState("");
  const [regTo, setRegTo]                 = useState("");
  const [payFrom, setPayFrom]             = useState("");
  const [payTo, setPayTo]                 = useState("");
  const [methods, setMethods]             = useState<{ label: string; value: string }[]>([]);
  const [lastUpdate, setLastUpdate]       = useState<Date | null>(null);
  const [tableWidth, setTableWidth]       = useState(0);
  const [fetchError, setFetchError]       = useState("");
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
    if (regFrom)       params.set("reg_from", regFrom);
    if (regTo)         params.set("reg_to", regTo);
    if (payFrom)       params.set("pay_from", payFrom);
    if (payTo)         params.set("pay_to", payTo);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/transactions?${params}`, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cargar datos");
      setData(json.data || []);
      setTotal(json.count || 0);
      setLastUpdate(new Date());
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setFetchError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }, [search, paymentMethod, regFrom, regTo, payFrom, payTo]);

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
  }, [search, paymentMethod, regFrom, regTo, payFrom, payTo, fetchData]);

  // Auto-refresh cada 5 segundos
  useEffect(() => {
    const interval = setInterval(() => {
      fetchData(page);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchData, page]);

  // Sincronizar scroll entre tabla y barra fija
  useEffect(() => {
    const tableEl = tableContainerRef.current;
    const fixedEl = fixedScrollRef.current;
    if (!tableEl || !fixedEl) return;

    let ticking = false;

    const onTable = () => {
      if (!ticking) {
        ticking = true;
        fixedEl.scrollLeft = tableEl.scrollLeft;
        ticking = false;
      }
    };
    const onFixed = () => {
      if (!ticking) {
        ticking = true;
        tableEl.scrollLeft = fixedEl.scrollLeft;
        ticking = false;
      }
    };

    tableEl.addEventListener("scroll", onTable, { passive: true });
    fixedEl.addEventListener("scroll", onFixed, { passive: true });
    return () => {
      tableEl.removeEventListener("scroll", onTable);
      fixedEl.removeEventListener("scroll", onFixed);
    };
  }, []);

  // Medir el ancho real de la tabla para la barra fija
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

  const fmt = (v: string | null) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">Transacciones consolidadas</h1>
          <span className="flex items-center gap-1.5 bg-green-100 text-green-700 text-xs font-medium px-2.5 py-1 rounded-full">
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
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 border border-gray-300 text-gray-700 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Cerrar sesión
          </button>
          <button
            onClick={downloadExcel}
            disabled={loading}
            className="flex items-center gap-1.5 bg-gray-900 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Descargar Excel
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white border-b px-6 py-3 space-y-3">
        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative w-80">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por documento, código transacción 1 o correo..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full border border-gray-300 rounded-lg pl-9 pr-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
          <select
            value={paymentMethod}
            onChange={(e) => { setPaymentMethod(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-400 bg-white"
          >
            <option value="" className="text-gray-900">Todos los medios</option>
            {methods.map((m) => (
              <option key={m.value} value={m.value} className="text-gray-900">{m.label}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-6 flex-wrap text-sm text-gray-600 items-center">
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha Registro</span>
            <input type="date" value={regFrom} onChange={(e) => { setRegFrom(e.target.value); setPage(1); }}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
            <span>→</span>
            <input type="date" value={regTo} onChange={(e) => { setRegTo(e.target.value); setPage(1); }}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha Pago</span>
            <input type="date" value={payFrom} onChange={(e) => { setPayFrom(e.target.value); setPage(1); }}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
            <span>→</span>
            <input type="date" value={payTo} onChange={(e) => { setPayTo(e.target.value); setPage(1); }}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </div>
          {(search || paymentMethod || regFrom || regTo || payFrom || payTo) && (
            <button
              onClick={() => { setSearch(""); setPaymentMethod(""); setRegFrom(""); setRegTo(""); setPayFrom(""); setPayTo(""); setPage(1); }}
              className="text-red-500 hover:text-red-700 text-xs underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {/* Conteo */}
      <div className="px-6 py-2 text-sm text-gray-500">
        {loading ? "Cargando..." : `${total.toLocaleString("es-CO")} registros encontrados`}
      </div>

      {fetchError && (
        <div className="mx-6 mb-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {fetchError}
        </div>
      )}

      {/* Tabla */}
      <div ref={tableContainerRef} className="px-6 pb-6 overflow-x-auto">
        <table className="w-full text-sm border-collapse bg-white rounded-lg shadow-sm overflow-hidden">
          <thead>
            <tr className="bg-gray-100 text-gray-600 text-left">
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
            </tr>
          </thead>
          <tbody>
            {loading && data.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-12 text-gray-400">Cargando...</td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-12 text-gray-400">No hay registros</td>
              </tr>
            ) : (
              data.map((row) => (
                <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.registration_date)}</td>
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.identification)}</td>
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.payment_date)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_1)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{fmt(row.transaction_code_2)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{fmt(row.email)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{fmt(row.program)}</td>
                  <td className="px-4 py-2.5 text-gray-700">{fmt(row.phone)}</td>
                  <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.payment_amount)}</td>
                  <td className="px-4 py-2.5">
                    <span className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">
                      {fmt(row.payment_method)}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Paginación */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 text-sm text-gray-600">
            <span>Página {page} de {totalPages}</span>
            <div className="flex gap-1">
              <button onClick={() => handlePage(1)} disabled={page === 1}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100">«</button>
              <button onClick={() => handlePage(page - 1)} disabled={page === 1}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100">‹</button>
              {[...Array(Math.min(5, totalPages))].map((_, i) => {
                const p = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
                return (
                  <button key={p} onClick={() => handlePage(p)}
                    className={`px-2 py-1 border rounded hover:bg-gray-100 ${p === page ? "bg-gray-900 text-white border-gray-900" : ""}`}>
                    {p}
                  </button>
                );
              })}
              <button onClick={() => handlePage(page + 1)} disabled={page === totalPages}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100">›</button>
              <button onClick={() => handlePage(totalPages)} disabled={page === totalPages}
                className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-100">»</button>
            </div>
          </div>
        )}
      </div>

      {/* Scrollbar horizontal fijo en la parte inferior de la pantalla */}
      <div
        ref={fixedScrollRef}
        className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200"
        style={{ overflowX: "scroll", overflowY: "hidden", height: 20 }}
      >
        <div style={{ width: tableWidth, height: 1 }} />
      </div>

      {/* Espaciado para que el contenido no quede tapado por la barra fija */}
      <div style={{ height: 20 }} />
    </div>
  );
}
