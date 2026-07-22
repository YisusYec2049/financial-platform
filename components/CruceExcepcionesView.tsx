"use client";

import { useEffect, useState, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";
import { useReproceso } from "@/lib/useReproceso";

export type CruceExcepcionesViewRef = { refresh: () => void };

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
  nombre: string | null;
  metodo_de_pago: string | null;
  ci: string | null;
  cruce: string | null;
  excepcion_motivo: string | null;
  estado_cruce: string | null;
};

type EditState = { incp: string; correo_2: string; nombre: string; metodo_de_pago: string; ci: string };

type NoteInfo = { fuente: string; clave: string; comentario: string; actualizado_en: string };
type NoteKey = { fuente: string; clave: string };

const MOTIVO_LABEL: Record<string, string> = {
  sin_cruce: "Sin cruce",
  cruce_ambiguo: "Cruce ambiguo",
  cruce_discrepante: "Discrepante",
  sin_identificar_pagador: "Pagador sin identificar",
  cruce_unico: "Solo Correo(2) (sin INCP)",
  pendiente_asignar_incp: "Pendiente de asignar INCP",
};

const MOTIVO_BADGE: Record<string, string> = {
  sin_cruce: "bg-red-50 text-red-700",
  cruce_ambiguo: "bg-amber-50 text-amber-700",
  cruce_discrepante: "bg-purple-50 text-purple-700",
  sin_identificar_pagador: "bg-blue-50 text-blue-700",
  cruce_unico: "bg-teal-50 text-teal-700",
  pendiente_asignar_incp: "bg-indigo-50 text-indigo-700",
};

const NOTA_FUENTE_LABEL: Record<string, string> = {
  incp: "Nota (INCP)",
  correo_bc2576: "Nota (correo Bancolombia)",
  correo_wompi: "Nota (correo Wompi)",
  correo_stripe: "Nota (correo Stripe)",
};

// Determina contra cuál hoja de correo se compara esta fila, según cruzar.py:
// BANCOLOMBIA -> correo_bc2576, WOMPI* -> correo_wompi, STRIPE_USA -> correo_stripe.
// Placetopay y otros medios no tienen lookup de correo_2, solo aplica INCP.
function correoFuente(paymentMethod: string | null): string | null {
  const pm = (paymentMethod || "").toUpperCase();
  if (pm === "BANCOLOMBIA") return "correo_bc2576";
  if (pm.startsWith("WOMPI")) return "correo_wompi";
  if (pm === "STRIPE_USA") return "correo_stripe";
  return null;
}

function noteKeysForRow(row: ExcepcionRow): NoteKey[] {
  const keys: NoteKey[] = [];
  if (row.identification?.trim()) keys.push({ fuente: "incp", clave: row.identification.trim() });
  const fuente = correoFuente(row.payment_method);
  if (fuente && row.email?.trim()) keys.push({ fuente, clave: row.email.trim().toLowerCase() });
  return keys;
}

const noteMapKey = (fuente: string, clave: string) => `${fuente}:${clave}`;

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

const CruceExcepcionesView = forwardRef<CruceExcepcionesViewRef>(function CruceExcepcionesView(_props, ref) {
  const [data, setData]                   = useState<ExcepcionRow[]>([]);
  const [total, setTotal]                 = useState(0);
  const [page, setPage]                   = useState(1);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useSessionState("cruce_excepciones.search", "");
  const [excepcionMotivo, setExcepcionMotivo] = useSessionState("cruce_excepciones.excepcionMotivo", "");
  const [incpCorreo, setIncpCorreo]       = useSessionState("cruce_excepciones.incpCorreo", "");
  const [paymentMethod, setPaymentMethod] = useSessionState("cruce_excepciones.paymentMethod", "");
  const [payFrom, setPayFrom]             = useSessionState("cruce_excepciones.payFrom", "");
  const [payTo, setPayTo]                 = useSessionState("cruce_excepciones.payTo", "");
  const [regFrom, setRegFrom]             = useSessionState("cruce_excepciones.regFrom", "");
  const [regTo, setRegTo]                 = useSessionState("cruce_excepciones.regTo", "");
  const [methods, setMethods]             = useState<{ label: string; value: string }[]>([]);
  const [fetchError, setFetchError]       = useState("");
  const [edits, setEdits]                 = useState<Record<string, EditState>>({});
  const [rowActionError, setRowActionError] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey]         = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen]   = useState(false);
  const [discardOpen, setDiscardOpen]         = useState<Record<string, boolean>>({});
  const [discardCandidates, setDiscardCandidates] = useState<Record<string, string[]>>({});
  const [discardLoading, setDiscardLoading]   = useState<Record<string, boolean>>({});
  const [discardError, setDiscardError]       = useState<Record<string, string>>({});
  const [discardMessage, setDiscardMessage]   = useState<Record<string, string>>({});
  const [discardingKey, setDiscardingKey]     = useState<string | null>(null);
  const [notes, setNotes]                     = useState<Record<string, NoteInfo>>({});
  const [noteEdits, setNoteEdits]             = useState<Record<string, string>>({});
  const [docEdits, setDocEdits]               = useState<Record<string, string>>({});
  const [docSaving, setDocSaving]             = useState<string | null>(null);
  const [docMessage, setDocMessage]           = useState<Record<string, string>>({});
  const [docError, setDocError]               = useState<Record<string, string>>({});
  const searchTimeout                     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef                = useRef<AbortController | null>(null);
  const tableContainerRef                 = useRef<HTMLDivElement>(null);
  const dropdownRef                       = useRef<HTMLDivElement>(null);

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

  const fetchNotes = useCallback(async (rows: ExcepcionRow[]) => {
    const keyMap = new Map<string, NoteKey>();
    for (const row of rows) {
      for (const k of noteKeysForRow(row)) keyMap.set(noteMapKey(k.fuente, k.clave), k);
    }
    if (keyMap.size === 0) { setNotes({}); return; }
    try {
      const res  = await fetch("/api/cruce/notes/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: [...keyMap.values()] }),
      });
      const json = await res.json();
      if (!res.ok) return;
      const map: Record<string, NoteInfo> = {};
      for (const n of (json.notes || []) as NoteInfo[]) map[noteMapKey(n.fuente, n.clave)] = n;
      setNotes(map);
    } catch {
      // Silencioso: las notas son informativas, no deben bloquear la vista de excepciones.
    }
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
    if (regFrom)         params.set("reg_from", regFrom);
    if (regTo)           params.set("reg_to", regTo);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/cruce/exceptions?${params}`, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cargar datos");
      setData(json.data || []);
      setTotal(json.count || 0);
      fetchNotes(json.data || []);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setFetchError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }, [search, excepcionMotivo, incpCorreo, paymentMethod, payFrom, payTo, regFrom, regTo, fetchNotes]);

  useImperativeHandle(ref, () => ({
    refresh: () => fetchData(page),
  }), [fetchData, page]);

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
  }, [search, excepcionMotivo, incpCorreo, paymentMethod, payFrom, payTo, regFrom, regTo, fetchData]);

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
    if (search)          params.set("search", search);
    if (excepcionMotivo) params.set("excepcion_motivo", excepcionMotivo);
    if (incpCorreo)      params.set("incp_correo", incpCorreo);
    if (paymentMethod)   params.set("payment_method", paymentMethod);
    if (payFrom)         params.set("pay_from", payFrom);
    if (payTo)           params.set("pay_to", payTo);
    if (regFrom)         params.set("reg_from", regFrom);
    if (regTo)           params.set("reg_to", regTo);
    return params;
  };

  const downloadExcel = async () => {
    setDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const res  = await fetch(`/api/cruce/exceptions/download?${buildDownloadParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      const allRows = json.data || [];
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const ws = XLSX.utils.json_to_sheet(allRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Excepciones");
      XLSX.writeFile(wb, `excepciones_cruce_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
      const res  = await fetch(`/api/cruce/exceptions/download?${buildDownloadParams()}`);
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
      a.download = `excepciones_cruce_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  };

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
    edits[row.matching_key] ?? {
      incp: row.incp ?? "",
      correo_2: row.correo_2 ?? "",
      nombre: row.nombre ?? "",
      metodo_de_pago: row.metodo_de_pago ?? "",
      ci: row.ci ?? "",
    };

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
    setNoteEdits((prev) => {
      const next = { ...prev };
      delete next[matchingKey];
      return next;
    });
  };

  const getNoteEdit = (row: ExcepcionRow): string => {
    if (noteEdits[row.matching_key] !== undefined) return noteEdits[row.matching_key];
    for (const k of noteKeysForRow(row)) {
      const existing = notes[noteMapKey(k.fuente, k.clave)];
      if (existing) return existing.comentario;
    }
    return "";
  };

  // Guarda el mismo comentario contra cada lookup aplicable a la fila (INCP y/o correo_*),
  // ya que la nota está asociada a la persona, no a la transacción puntual.
  const persistNote = async (row: ExcepcionRow) => {
    const comentario = getNoteEdit(row).trim();
    if (!comentario) return;
    const keys = noteKeysForRow(row);
    await Promise.all(
      keys.map((k) =>
        fetch("/api/cruce/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fuente: k.fuente, clave: k.clave, comentario }),
        }).catch(() => null)
      )
    );
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
          nombre: edit.nombre,
          metodo_de_pago: edit.metodo_de_pago,
          ci: edit.ci,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar");
      await persistNote(row);
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
      await persistNote(row);
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

  const toggleDiscardPanel = async (row: ExcepcionRow) => {
    const key = row.matching_key;
    const willOpen = !discardOpen[key];
    setDiscardOpen((prev) => ({ ...prev, [key]: willOpen }));
    if (willOpen && !discardCandidates[key]) {
      setDiscardLoading((prev) => ({ ...prev, [key]: true }));
      setDiscardError((prev) => ({ ...prev, [key]: "" }));
      try {
        const res = await fetch(`/api/cruce/exceptions/incp-candidates?identification=${encodeURIComponent(row.identification)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al cargar candidatos");
        setDiscardCandidates((prev) => ({ ...prev, [key]: json.candidates || [] }));
      } catch (err) {
        setDiscardError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
      } finally {
        setDiscardLoading((prev) => ({ ...prev, [key]: false }));
      }
    }
  };

  const handleDiscardCandidate = async (row: ExcepcionRow, candidate: string) => {
    const key = row.matching_key;
    setDiscardingKey(`${key}:${candidate}`);
    setDiscardError((prev) => ({ ...prev, [key]: "" }));
    try {
      const res = await fetch("/api/cruce/exceptions/discard-incp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identification: row.identification, id_inscripcion_excluido: candidate }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descartar");
      setDiscardCandidates((prev) => ({ ...prev, [key]: (prev[key] || []).filter((c) => c !== candidate) }));
      setDiscardMessage((prev) => ({ ...prev, [key]: "Se descartó este número. La fila se actualizará automáticamente en el próximo cruce." }));
    } catch (err) {
      setDiscardError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setDiscardingKey(null);
    }
  };

  // El pipeline corre 1 vez al día; corregir el documento debe poder
  // reprocesarse de inmediato en vez de esperar al cron (spec §6).
  const { fireTrigger, reprocesoBadge } = useReproceso(() => fetchData(page));

  const handleSaveDocumento = async (row: ExcepcionRow) => {
    const nuevo = (docEdits[row.matching_key] ?? row.identification).trim();
    if (!nuevo || nuevo === row.identification) return;
    setDocSaving(row.matching_key);
    setDocError((prev) => ({ ...prev, [row.matching_key]: "" }));
    setDocMessage((prev) => ({ ...prev, [row.matching_key]: "" }));
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
      // La fila de cruce_cartera conserva a propósito el documento viejo (es la señal
      // que usa matching-test para saber que hay que volver a cruzar), así que al
      // recargar la vista se volverá a ver el anterior hasta que el pipeline reprocese.
      setDocMessage((prev) => ({ ...prev, [row.matching_key]: "Documento corregido. Se aplicará en el próximo cruce." }));
      fireTrigger();
    } catch (err) {
      setDocError((prev) => ({ ...prev, [row.matching_key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setDocSaving(null);
    }
  };

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  return (
    <div className="space-y-4">
      {reprocesoBadge}
      <div className={`${PANEL} animate-fade-in px-6 py-4 space-y-3`}>
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
            <option value="sin_identificar_pagador" className="text-gray-900">Pagador sin identificar</option>
            <option value="cruce_unico" className="text-gray-900">Solo Correo(2) (sin INCP)</option>
            <option value="pendiente_asignar_incp" className="text-gray-900">Pendiente de asignar INCP</option>
            {/* No es un excepcion_motivo: el backend lo traduce a estado_cruce = 'no_identificable'. */}
            <option value="no_identificable" className="text-gray-900">No identificado (cerrado a mano)</option>
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
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha de Ingreso</span>
            <input type="date" value={regFrom} onChange={(e) => { setRegFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={regTo} onChange={(e) => { setRegTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          {(search || excepcionMotivo || incpCorreo || paymentMethod || payFrom || payTo || regFrom || regTo) && (
            <button
              onClick={() => { setSearch(""); setExcepcionMotivo(""); setIncpCorreo(""); setPaymentMethod(""); setPayFrom(""); setPayTo(""); setRegFrom(""); setRegTo(""); setPage(1); }}
              className="text-red-500 hover:text-red-700 text-xs underline"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      <div className="px-1 flex items-center justify-between gap-3">
        <span className="text-sm text-gray-500">
          {loading ? "Cargando..." : `${total.toLocaleString("es-CO")} excepciones encontradas`}
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

      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] overflow-hidden`}>
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
                <th className="px-4 py-3 font-medium whitespace-nowrap">Excepción</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Acciones</th>
              </tr>
            </thead>
            <tbody key={page} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 17 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={17} className="text-center py-12 text-gray-400">No hay excepciones pendientes</td>
                </tr>
              ) : (
                groupedRows.map(({ row, grouped }) => {
                  const edit         = getEdit(row);
                  const saving       = savingKey === row.matching_key;
                  const rowErr       = rowActionError[row.matching_key];
                  const isDiscrepante = row.excepcion_motivo === "cruce_discrepante";
                  const isSinIdentificarPagador = row.excepcion_motivo === "sin_identificar_pagador";
                  const isCruceUnico = row.excepcion_motivo === "cruce_unico";
                  const isPendienteAsignarIncp = row.excepcion_motivo === "pendiente_asignar_incp";
                  // Fila ya cerrada a mano ("No se puede identificar"): no hay nada que
                  // corregir. Se muestra solo para consulta; guardar encima la reabriría.
                  const isResuelta = row.estado_cruce === "no_identificable";
                  return (
                    <tr
                      key={row.matching_key}
                      className={`hover:bg-gray-50/70 transition-colors duration-100 align-top ${
                        isDiscrepante
                          ? "bg-purple-50/40 border-l-2 border-l-purple-400"
                          : isSinIdentificarPagador
                          ? "bg-blue-50/40 border-l-2 border-l-blue-400"
                          : isCruceUnico
                          ? "bg-teal-50/40 border-l-2 border-l-teal-400"
                          : isPendienteAsignarIncp
                          ? "bg-indigo-50/40 border-l-2 border-l-indigo-400"
                          : grouped
                          ? "bg-amber-50/40 border-l-2 border-l-amber-400"
                          : ""
                      }`}
                    >
                    <td className="px-4 py-2.5">
                      {(() => {
                        const docValue = docEdits[row.matching_key] ?? row.identification;
                        const docChanged = docValue.trim() !== "" && docValue.trim() !== row.identification;
                        const savingDoc = docSaving === row.matching_key;
                        return (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={docValue}
                                onChange={(e) => setDocEdits((prev) => ({ ...prev, [row.matching_key]: e.target.value }))}
                                disabled={savingDoc}
                                className="w-28 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                              />
                              {docChanged && (
                                <button
                                  onClick={() => handleSaveDocumento(row)}
                                  disabled={savingDoc}
                                  title="Guardar corrección de documento"
                                  className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                                >
                                  ✓
                                </button>
                              )}
                            </div>
                            {docMessage[row.matching_key] && <span className="text-[11px] text-green-700">{docMessage[row.matching_key]}</span>}
                            {docError[row.matching_key] && <span className="text-[11px] text-red-600">{docError[row.matching_key]}</span>}
                          </div>
                        );
                      })()}
                    </td>
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
                    <td className={`px-4 py-2.5 ${isDiscrepante ? "bg-purple-50/60" : isCruceUnico ? "bg-teal-50/60" : isPendienteAsignarIncp ? "bg-indigo-50/60" : ""}`}>
                      <div className="flex items-center gap-1">
                        {isDiscrepante && <span title="Discrepa con Correo(2)" className="text-purple-600 text-xs">⚠️</span>}
                        {isCruceUnico && <span title="Sin INCP identificado" className="text-teal-600 text-xs">⚠️</span>}
                        {isPendienteAsignarIncp && <span title="Correo/nombre registrado, falta que el equipo asigne el INCP" className="text-indigo-600 text-xs">⚠️</span>}
                        {isResuelta ? (
                          <span className="text-gray-700 whitespace-nowrap">{fmt(row.incp)}</span>
                        ) : (
                        <input
                          type="text"
                          value={edit.incp}
                          onChange={(e) => setEdit(row.matching_key, "incp", e.target.value, row)}
                          disabled={saving}
                          className={`w-28 border rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100 ${
                            isDiscrepante ? "border-purple-400" : isCruceUnico ? "border-teal-400" : isPendienteAsignarIncp ? "border-indigo-400" : "border-gray-300"
                          }`}
                        />
                        )}
                      </div>
                    </td>
                    <td className={`px-4 py-2.5 ${isDiscrepante ? "bg-purple-50/60" : ""}`}>
                      <div className="flex items-center gap-1">
                        {isDiscrepante && <span title="Discrepa con INCP" className="text-purple-600 text-xs">⚠️</span>}
                        {isResuelta ? (
                          <span className="text-gray-700 whitespace-nowrap">{fmt(row.correo_2)}</span>
                        ) : (
                        <input
                          type="text"
                          value={edit.correo_2}
                          onChange={(e) => setEdit(row.matching_key, "correo_2", e.target.value, row)}
                          disabled={saving}
                          className={`w-36 border rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100 ${
                            isDiscrepante ? "border-purple-400" : "border-gray-300"
                          }`}
                        />
                        )}
                      </div>
                    </td>
                    <td className={`px-4 py-2.5 ${isSinIdentificarPagador ? "bg-blue-50/60" : ""}`}>
                      {isSinIdentificarPagador ? (
                        <input
                          type="text"
                          value={edit.nombre}
                          onChange={(e) => setEdit(row.matching_key, "nombre", e.target.value, row)}
                          disabled={saving}
                          className="w-32 border border-blue-400 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                      ) : (
                        <span className="text-gray-700 whitespace-nowrap">{fmt(row.nombre)}</span>
                      )}
                    </td>
                    <td className={`px-4 py-2.5 ${isSinIdentificarPagador ? "bg-blue-50/60" : ""}`}>
                      {isSinIdentificarPagador ? (
                        <input
                          type="text"
                          value={edit.metodo_de_pago}
                          onChange={(e) => setEdit(row.matching_key, "metodo_de_pago", e.target.value, row)}
                          disabled={saving}
                          className="w-32 border border-blue-400 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                      ) : (
                        <span className="text-gray-700 whitespace-nowrap">{fmt(row.metodo_de_pago)}</span>
                      )}
                    </td>
                    <td className={`px-4 py-2.5 ${isSinIdentificarPagador ? "bg-blue-50/60" : ""}`}>
                      {isSinIdentificarPagador ? (
                        <input
                          type="text"
                          value={edit.ci}
                          onChange={(e) => setEdit(row.matching_key, "ci", e.target.value, row)}
                          disabled={saving}
                          className="w-24 border border-blue-400 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                      ) : (
                        <span className="text-gray-700 whitespace-nowrap">{fmt(row.ci)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cruce)}</td>
                    <td className="px-4 py-2.5">
                      {isResuelta ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs px-2 py-0.5 rounded-full whitespace-nowrap bg-gray-200 text-gray-700">
                            No identificado
                          </span>
                          {row.excepcion_motivo && (
                            <span className="text-[11px] text-gray-400 whitespace-nowrap">
                              {MOTIVO_LABEL[row.excepcion_motivo] ?? row.excepcion_motivo}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${row.excepcion_motivo ? MOTIVO_BADGE[row.excepcion_motivo] ?? "bg-gray-100 text-gray-700" : "bg-gray-100 text-gray-700"}`}>
                          {row.excepcion_motivo ? MOTIVO_LABEL[row.excepcion_motivo] ?? row.excepcion_motivo : "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1 min-w-[190px]">
                        {noteKeysForRow(row).map((k) => {
                          const existing = notes[noteMapKey(k.fuente, k.clave)];
                          if (!existing) return null;
                          return (
                            <div key={k.fuente} className="bg-sky-50/70 border border-sky-200/80 rounded-lg px-2 py-1.5">
                              <p className="text-[11px] font-medium text-sky-800">{NOTA_FUENTE_LABEL[k.fuente] ?? "Nota"}</p>
                              <p className="text-xs text-sky-900 whitespace-pre-wrap">{existing.comentario}</p>
                            </div>
                          );
                        })}
                        {isResuelta ? (
                          <span className="text-[11px] text-gray-400">
                            Cerrada a mano — no requiere acción.
                          </span>
                        ) : (
                        <>
                        <textarea
                          placeholder="Nota sobre esta ambigüedad (opcional)..."
                          value={getNoteEdit(row)}
                          onChange={(e) => setNoteEdits((prev) => ({ ...prev, [row.matching_key]: e.target.value }))}
                          disabled={saving}
                          rows={2}
                          className="w-full text-xs border border-gray-300 rounded-lg px-2 py-1.5 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100 resize-none"
                        />
                        <button
                          onClick={() => handleSave(row)}
                          disabled={saving}
                          className="text-xs px-2.5 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800 hover:brightness-105 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 disabled:active:scale-100"
                        >
                          {saving ? "Guardando..." : "Guardar corrección"}
                        </button>
                        <button
                          onClick={() => handleNoIdentificable(row)}
                          disabled={saving}
                          className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 disabled:active:scale-100"
                        >
                          No se puede identificar
                        </button>
                        {row.excepcion_motivo === "cruce_ambiguo" && (
                          <button
                            onClick={() => toggleDiscardPanel(row)}
                            disabled={saving}
                            className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 disabled:active:scale-100"
                          >
                            {discardOpen[row.matching_key] ? "Ocultar candidatos" : "Descartar este número"}
                          </button>
                        )}
                        {discardOpen[row.matching_key] && (
                          <div className="animate-fade-in bg-amber-50/60 border border-amber-200/80 rounded-lg p-2 space-y-1.5">
                            {discardLoading[row.matching_key] ? (
                              <p className="text-xs text-gray-500">Cargando candidatos...</p>
                            ) : discardError[row.matching_key] ? (
                              <p className="text-xs text-red-600">{discardError[row.matching_key]}</p>
                            ) : (
                              <>
                                {(discardCandidates[row.matching_key]?.length ?? 0) >= 2 ? (
                                  <>
                                    <p className="text-xs text-gray-500">¿Cuál número NO corresponde a este pagador?</p>
                                    {discardCandidates[row.matching_key]!.map((c) => {
                                      const dKey = `${row.matching_key}:${c}`;
                                      return (
                                        <button
                                          key={c}
                                          onClick={() => handleDiscardCandidate(row, c)}
                                          disabled={discardingKey === dKey}
                                          className="w-full text-left text-xs px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-red-50 hover:border-red-300 hover:text-red-700 transition-colors disabled:opacity-50"
                                        >
                                          {discardingKey === dKey ? "Descartando..." : `Descartar ${c}`}
                                        </button>
                                      );
                                    })}
                                  </>
                                ) : (
                                  <p className="text-xs text-gray-500">
                                    No hay más de un candidato INCP activo para este documento — la ambigüedad no es de tipo INCP.
                                  </p>
                                )}
                                {discardMessage[row.matching_key] && (
                                  <p className="text-xs text-green-700">{discardMessage[row.matching_key]}</p>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        </>
                        )}
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
});

export default CruceExcepcionesView;
