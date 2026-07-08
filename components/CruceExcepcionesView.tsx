"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useSidebar } from "@/components/SidebarContext";

type ExcepcionRow = {
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
  excepcion_motivo: string | null;
};

type EditState = { incp: string; correo_2: string };

const MOTIVO_LABEL: Record<string, string> = {
  sin_cruce: "Sin cruce",
  cruce_ambiguo: "Cruce ambiguo",
  cruce_discrepante: "Discrepante",
};

const MOTIVO_BADGE: Record<string, string> = {
  sin_cruce: "bg-red-50 text-red-700",
  cruce_ambiguo: "bg-amber-50 text-amber-700",
  cruce_discrepante: "bg-purple-50 text-purple-700",
};

// Agrupa filas que comparten un mismo INCP o Correo(2) no vacío, para que
// aparezcan una debajo de la otra y sea fácil compararlas y resolver la ambigüedad.
function groupByIncpOrCorreo(rows: ExcepcionRow[]): { row: ExcepcionRow; grouped: boolean }[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  rows.forEach((r) => find(r.matching_key));

  const byIncp = new Map<string, string>();
  const byCorreo = new Map<string, string>();
  for (const r of rows) {
    const incpKey = r.incp?.trim().toLowerCase();
    if (incpKey) {
      if (byIncp.has(incpKey)) union(r.matching_key, byIncp.get(incpKey)!);
      else byIncp.set(incpKey, r.matching_key);
    }
    const correoKey = r.correo_2?.trim().toLowerCase();
    if (correoKey) {
      if (byCorreo.has(correoKey)) union(r.matching_key, byCorreo.get(correoKey)!);
      else byCorreo.set(correoKey, r.matching_key);
    }
  }

  const groupSize = new Map<string, number>();
  for (const r of rows) {
    const root = find(r.matching_key);
    groupSize.set(root, (groupSize.get(root) ?? 0) + 1);
  }

  const groupOrder: string[] = [];
  const seen = new Set<string>();
  const buckets = new Map<string, ExcepcionRow[]>();
  for (const r of rows) {
    const root = find(r.matching_key);
    if (!seen.has(root)) { seen.add(root); groupOrder.push(root); }
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root)!.push(r);
  }

  const result: { row: ExcepcionRow; grouped: boolean }[] = [];
  for (const root of groupOrder) {
    const grouped = (groupSize.get(root) ?? 1) > 1;
    for (const row of buckets.get(root)!) result.push({ row, grouped });
  }
  return result;
}

export default function CruceExcepcionesView() {
  const { width: sidebarWidth }           = useSidebar();
  const [data, setData]                   = useState<ExcepcionRow[]>([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useState("");
  const [excepcionMotivo, setExcepcionMotivo] = useState("");
  const [incpCorreo, setIncpCorreo]       = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [payFrom, setPayFrom]             = useState("");
  const [payTo, setPayTo]                 = useState("");
  const [methods, setMethods]             = useState<{ label: string; value: string }[]>([]);
  const [fetchError, setFetchError]       = useState("");
  const [tableWidth, setTableWidth]       = useState(0);
  const [edits, setEdits]                 = useState<Record<string, EditState>>({});
  const [rowActionError, setRowActionError] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey]         = useState<string | null>(null);
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
    if (search)          params.set("search", search);
    if (excepcionMotivo) params.set("excepcion_motivo", excepcionMotivo);
    if (incpCorreo)      params.set("incp_correo", incpCorreo);
    if (paymentMethod)   params.set("payment_method", paymentMethod);
    if (payFrom)         params.set("pay_from", payFrom);
    if (payTo)           params.set("pay_to", payTo);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/cruce/exceptions?${params}`, { signal });
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
  }, [search, excepcionMotivo, incpCorreo, paymentMethod, payFrom, payTo]);

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
  }, [search, excepcionMotivo, incpCorreo, paymentMethod, payFrom, payTo, fetchData]);

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
  const groupedRows = useMemo(() => groupByIncpOrCorreo(data), [data]);

  const handlePage = (p: number) => {
    setPage(p);
    fetchData(p);
  };

  const fmt = (v: string | null) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  const getEdit = (row: ExcepcionRow): EditState =>
    edits[row.matching_key] ?? { incp: row.incp ?? "", correo_2: row.correo_2 ?? "" };

  const setEdit = (matchingKey: string, field: keyof EditState, value: string, row: ExcepcionRow) => {
    setEdits((prev) => ({
      ...prev,
      [matchingKey]: { ...getEdit(row), ...prev[matchingKey], [field]: value },
    }));
  };

  const removeRow = (matchingKey: string) => {
    setData((prev) => prev.filter((r) => r.matching_key !== matchingKey));
    setTotal((prev) => Math.max(0, prev - 1));
    setEdits((prev) => {
      const next = { ...prev };
      delete next[matchingKey];
      return next;
    });
  };

  const handleSave = async (row: ExcepcionRow) => {
    const edit = getEdit(row);
    setSavingKey(row.matching_key);
    setRowActionError((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const res = await fetch("/api/cruce/exceptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matching_key: row.matching_key,
          incp: edit.incp,
          correo_2: edit.correo_2,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar");
      removeRow(row.matching_key);
    } catch (err) {
      setRowActionError((prev) => ({
        ...prev,
        [row.matching_key]: err instanceof Error ? err.message : "Error inesperado",
      }));
    } finally {
      setSavingKey(null);
    }
  };

  const handleNoIdentificable = async (row: ExcepcionRow) => {
    setSavingKey(row.matching_key);
    setRowActionError((prev) => ({ ...prev, [row.matching_key]: "" }));
    try {
      const res = await fetch("/api/cruce/exceptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matching_key: row.matching_key,
          no_identificable: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar");
      removeRow(row.matching_key);
    } catch (err) {
      setRowActionError((prev) => ({
        ...prev,
        [row.matching_key]: err instanceof Error ? err.message : "Error inesperado",
      }));
    } finally {
      setSavingKey(null);
    }
  };

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  return (
    <div className="space-y-4">
      <div className={`${PANEL} px-6 py-4 space-y-3`}>
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
            value={excepcionMotivo}
            onChange={(e) => { setExcepcionMotivo(e.target.value); setPage(1); }}
            className={INPUT}
          >
            <option value="" className="text-gray-900">Todos los motivos</option>
            <option value="sin_cruce" className="text-gray-900">Sin cruce</option>
            <option value="cruce_ambiguo" className="text-gray-900">Cruce ambiguo</option>
            <option value="cruce_discrepante" className="text-gray-900">Discrepante (INCP ≠ Correo(2))</option>
          </select>
          <div className="relative w-64">
            <input
              type="text"
              placeholder="Buscar por INCP o Correo(2)..."
              value={incpCorreo}
              onChange={(e) => setIncpCorreo(e.target.value)}
              className={`w-full ${INPUT}`}
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
          {(search || excepcionMotivo || incpCorreo || paymentMethod || payFrom || payTo) && (
            <button
              onClick={() => { setSearch(""); setExcepcionMotivo(""); setIncpCorreo(""); setPaymentMethod(""); setPayFrom(""); setPayTo(""); setPage(1); }}
              className="text-red-500 hover:text-red-700 text-xs underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      <div className="px-1 text-sm text-gray-500">
        {loading ? "Cargando..." : `${total.toLocaleString("es-CO")} excepciones encontradas`}
      </div>

      {fetchError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2">
          {fetchError}
        </div>
      )}

      <div className={`${PANEL} overflow-hidden`}>
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
                <th className="px-4 py-3 font-medium whitespace-nowrap">Excepción</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 13 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={13} className="text-center py-12 text-gray-400">No hay excepciones pendientes</td>
                </tr>
              ) : (
                groupedRows.map(({ row, grouped }) => {
                  const edit         = getEdit(row);
                  const saving       = savingKey === row.matching_key;
                  const rowErr       = rowActionError[row.matching_key];
                  const isDiscrepante = row.excepcion_motivo === "cruce_discrepante";
                  return (
                    <tr
                      key={row.matching_key}
                      className={`hover:bg-gray-50/70 transition-colors duration-100 align-top ${
                        isDiscrepante
                          ? "bg-purple-50/40 border-l-2 border-l-purple-400"
                          : grouped
                          ? "bg-amber-50/40 border-l-2 border-l-amber-400"
                          : ""
                      }`}
                    >
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
                    <td className={`px-4 py-2.5 ${isDiscrepante ? "bg-purple-50/60" : ""}`}>
                      <div className="flex items-center gap-1">
                        {isDiscrepante && <span title="Discrepa con Correo(2)" className="text-purple-600 text-xs">⚠️</span>}
                        <input
                          type="text"
                          value={edit.incp}
                          onChange={(e) => setEdit(row.matching_key, "incp", e.target.value, row)}
                          disabled={saving}
                          className={`w-28 border rounded px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-100 ${
                            isDiscrepante ? "border-purple-400" : "border-gray-300"
                          }`}
                        />
                      </div>
                    </td>
                    <td className={`px-4 py-2.5 ${isDiscrepante ? "bg-purple-50/60" : ""}`}>
                      <div className="flex items-center gap-1">
                        {isDiscrepante && <span title="Discrepa con INCP" className="text-purple-600 text-xs">⚠️</span>}
                        <input
                          type="text"
                          value={edit.correo_2}
                          onChange={(e) => setEdit(row.matching_key, "correo_2", e.target.value, row)}
                          disabled={saving}
                          className={`w-36 border rounded px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-100 ${
                            isDiscrepante ? "border-purple-400" : "border-gray-300"
                          }`}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${row.excepcion_motivo ? MOTIVO_BADGE[row.excepcion_motivo] ?? "bg-gray-100 text-gray-700" : "bg-gray-100 text-gray-700"}`}>
                        {row.excepcion_motivo ? MOTIVO_LABEL[row.excepcion_motivo] ?? row.excepcion_motivo : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1 min-w-[110px]">
                        <button
                          onClick={() => handleSave(row)}
                          disabled={saving}
                          className="text-xs px-2 py-1 rounded bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-150 disabled:opacity-50"
                        >
                          {saving ? "Guardando..." : "Guardar corrección"}
                        </button>
                        <button
                          onClick={() => handleNoIdentificable(row)}
                          disabled={saving}
                          className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-150 disabled:opacity-50"
                        >
                          No se puede identificar
                        </button>
                        {rowErr && <span className="text-xs text-red-600">{rowErr}</span>}
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
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">«</button>
              <button onClick={() => handlePage(page - 1)} disabled={page === 1}
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">‹</button>
              {[...Array(Math.min(5, totalPages))].map((_, i) => {
                const p = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
                return (
                  <button key={p} onClick={() => handlePage(p)}
                    className={`min-w-7 h-7 px-2 rounded-full hover:bg-gray-100 active:scale-95 transition-all duration-150 ${p === page ? "bg-brand-600 text-white shadow-sm hover:bg-brand-600" : ""}`}>
                    {p}
                  </button>
                );
              })}
              <button onClick={() => handlePage(page + 1)} disabled={page === totalPages}
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">›</button>
              <button onClick={() => handlePage(totalPages)} disabled={page === totalPages}
                className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40 hover:bg-gray-100 active:scale-95 transition-all duration-150">»</button>
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
