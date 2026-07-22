"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";
import { useReproceso } from "@/lib/useReproceso";

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
  fecha_cruce: string | null;
  notificacion: string | null;
};

type PagoAsociable = {
  matching_key: string;
  payment_amount: number;
  payment_date: string;
  transaction_code_1: string | null;
  restante: number;
};

type InscripcionPendiente = {
  llave: string;
  inscrip: string;
  valor_a_cobrar: number;
  valor_cuota: number;
  sistema_financiero: string | null;
  fecha_vencimiento: string;
};

// Regla #4/#7 (Spec Auto Cartera): ledger de saldos a favor no auto-aplicados
// (sobrantes y descartes), agrupables por documento+correo.
type SaldoFavorRow = {
  id: number;
  documento: string | null;
  correo: string | null;
  cliente: string | null;
  inscrip: string | null;
  llave_origen: string | null;
  matching_key: string;
  monto: number;
  disponible: number;
  fecha: string | null;
  origen: string | null;
};

// Regla #3: asociación pago↔cuota ya aplicada, candidata a descartar.
type AsociacionRow = {
  id: number;
  matching_key: string;
  monto: number;
  origen: string;
  created_at: string;
  transaction_code_1: string | null;
  payment_date: string | null;
};

export default function CarteraPreventivaView() {
  const [data, setData]                 = useState<CarteraPreventivaRow[]>([]);
  const [total, setTotal]               = useState(0);
  const [page, setPage]                 = useState(1);
  const [loading, setLoading]           = useState(false);
  const [search, setSearch]             = useSessionState("cartera_preventiva.search", "");
  const [estado, setEstado]             = useSessionState("cartera_preventiva.estado", "todas");
  const [vencFrom, setVencFrom]         = useSessionState("cartera_preventiva.vencFrom", "");
  const [vencTo, setVencTo]             = useSessionState("cartera_preventiva.vencTo", "");
  const [pagoParcial, setPagoParcial]   = useSessionState("cartera_preventiva.pagoParcial", false);
  const [medioPago, setMedioPago]       = useSessionState("cartera_preventiva.medioPago", "");
  const [wompiTipo, setWompiTipo]       = useSessionState("cartera_preventiva.wompiTipo", "");
  const [payFrom, setPayFrom]           = useSessionState("cartera_preventiva.payFrom", "");
  const [payTo, setPayTo]               = useSessionState("cartera_preventiva.payTo", "");
  const [cruceFrom, setCruceFrom]       = useSessionState("cartera_preventiva.cruceFrom", "");
  const [cruceTo, setCruceTo]           = useSessionState("cartera_preventiva.cruceTo", "");
  const [conNotificacion, setConNotificacion] = useSessionState("cartera_preventiva.conNotificacion", false);
  const [medios, setMedios]             = useState<{ label: string; value: string }[]>([]);
  const [fetchError, setFetchError]     = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [multiInscripcionDocs, setMultiInscripcionDocs] = useState<Set<string>>(new Set());
  const [ultimaCuotaLlaves, setUltimaCuotaLlaves] = useState<Set<string>>(new Set());
  const [asociarOpen, setAsociarOpen]           = useState<Record<string, boolean>>({});
  const [asociarData, setAsociarData]           = useState<Record<string, { inscripciones: InscripcionPendiente[]; pagos: PagoAsociable[] }>>({});
  const [asociarLoading, setAsociarLoading]     = useState<Record<string, boolean>>({});
  const [asociarError, setAsociarError]         = useState<Record<string, string>>({});
  const [asociarMessage, setAsociarMessage]     = useState<Record<string, string>>({});
  const [montoOtroValor, setMontoOtroValor]     = useState<Record<string, string>>({});
  const [cierreOpen, setCierreOpen]             = useState<Record<string, boolean>>({});
  const [cierreFecha, setCierreFecha]           = useState<Record<string, string>>({});
  const [cuotaEdits, setCuotaEdits]             = useState<Record<string, string>>({});
  const [rowSaving, setRowSaving]               = useState<string | null>(null);
  const [rowMessage, setRowMessage]             = useState<Record<string, string>>({});
  const [rowError, setRowError]                 = useState<Record<string, string>>({});
  const [saldosFavor, setSaldosFavor]           = useState<SaldoFavorRow[]>([]);
  const [asociarSaldoOpen, setAsociarSaldoOpen] = useState<Record<string, boolean>>({});
  const [saldoOtroValor, setSaldoOtroValor]     = useState<Record<string, string>>({});
  const [descartarOpen, setDescartarOpen]       = useState<Record<string, boolean>>({});
  const [descartarData, setDescartarData]       = useState<Record<string, AsociacionRow[]>>({});
  const [descartarLoading, setDescartarLoading] = useState<Record<string, boolean>>({});
  const [descartarError, setDescartarError]     = useState<Record<string, string>>({});
  const [stagingCount, setStagingCount]         = useState(0);
  const [activando, setActivando]               = useState(false);
  const [activarMessage, setActivarMessage]     = useState("");
  const [activarError, setActivarError]         = useState("");
  const searchTimeout                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef              = useRef<AbortController | null>(null);
  const tableContainerRef               = useRef<HTMLDivElement>(null);
  const dropdownRef                     = useRef<HTMLDivElement>(null);

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
    if (pagoParcial)  params.set("pago_parcial", "1");
    if (medioPago)    params.set("medio_pago", medioPago);
    if (payFrom)      params.set("pay_from", payFrom);
    if (payTo)        params.set("pay_to", payTo);
    if (cruceFrom)    params.set("cruce_from", cruceFrom);
    if (cruceTo)      params.set("cruce_to", cruceTo);
    if (conNotificacion) params.set("con_notificacion", "1");
    if (medioPago === "WOMPI%" && wompiTipo) params.set("wompi_tipo", wompiTipo);
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
  }, [search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, wompiTipo]);

  const fetchMedios = useCallback(async () => {
    const res  = await fetch("/api/cartera-preventiva/medios-pago");
    const raw: string[] = await res.json();

    // Agrupar WOMPI y Placetopay en una sola opción (Filtro 1, spec Wompi-Placetopay)
    const grouped: { label: string; value: string }[] = [];
    let addedWompi      = false;
    let addedPlacetopay = false;

    for (const m of raw) {
      if (m.toUpperCase().startsWith("WOMPI")) {
        if (!addedWompi) { grouped.push({ label: "Wompi", value: "WOMPI%" }); addedWompi = true; }
      } else if (m.toLowerCase().startsWith("placetopay")) {
        if (!addedPlacetopay) { grouped.push({ label: "Placetopay", value: "PLACETOPAY%" }); addedPlacetopay = true; }
      } else {
        grouped.push({ label: m, value: m });
      }
    }

    setMedios(grouped);
  }, []);

  const fetchMultiInscripcion = useCallback(async () => {
    try {
      const res  = await fetch("/api/cartera-preventiva/multi-inscripcion");
      const json = await res.json();
      if (res.ok) setMultiInscripcionDocs(new Set(json.documentos || []));
    } catch {
      // No bloquea la vista si falla — el panel de asociar simplemente no aparecerá.
    }
  }, []);

  const fetchUltimaCuota = useCallback(async () => {
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides");
      const json = await res.json();
      if (res.ok) setUltimaCuotaLlaves(new Set(json.llaves || []));
    } catch {
      // No bloquea la vista si falla — el botón simplemente arranca sin marcar.
    }
  }, []);

  const fetchSaldosFavor = useCallback(async () => {
    try {
      const res  = await fetch("/api/cartera-preventiva/saldos-favor");
      const json = await res.json();
      if (res.ok) setSaldosFavor(json.data || []);
    } catch {
      // No bloquea la vista si falla — el mensaje de saldo simplemente no aparecerá.
    }
  }, []);

  const fetchStagingStatus = useCallback(async () => {
    try {
      const res  = await fetch("/api/cartera-preventiva/staging-status");
      const json = await res.json();
      if (res.ok) setStagingCount(json.count || 0);
    } catch {
      // No bloquea la vista si falla — el banner simplemente no aparece.
    }
  }, []);

  useEffect(() => {
    fetchMedios();
    fetchMultiInscripcion();
    fetchUltimaCuota();
    fetchSaldosFavor();
    fetchStagingStatus();
  }, [fetchMedios, fetchMultiInscripcion, fetchUltimaCuota, fetchSaldosFavor, fetchStagingStatus]);

  // Regla #4/#7: saldos disponibles agrupados por documento+correo (misma
  // pareja que identifica al "cliente" en cartera_saldos_favor). Rows con
  // documento/correo null (ledger viejo, previo a esta spec) no agrupan con
  // nada — no rompen, simplemente no ofrecen el flujo de asociar.
  const saldoPorGrupo = useMemo(() => {
    const map = new Map<string, { total: number; rows: SaldoFavorRow[] }>();
    for (const s of saldosFavor) {
      if (!s.documento || !s.correo) continue;
      const key = `${s.documento}|${s.correo}`;
      if (!map.has(key)) map.set(key, { total: 0, rows: [] });
      const entry = map.get(key)!;
      entry.total += Number(s.disponible);
      entry.rows.push(s);
    }
    return map;
  }, [saldosFavor]);

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      fetchData(1);
    }, 400);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, wompiTipo, fetchData]);


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
    if (search)       params.set("search", search);
    if (estado !== "todas") params.set("estado", estado);
    if (vencFrom)     params.set("venc_from", vencFrom);
    if (vencTo)       params.set("venc_to", vencTo);
    if (pagoParcial)  params.set("pago_parcial", "1");
    if (medioPago)    params.set("medio_pago", medioPago);
    if (payFrom)      params.set("pay_from", payFrom);
    if (payTo)        params.set("pay_to", payTo);
    if (cruceFrom)    params.set("cruce_from", cruceFrom);
    if (cruceTo)      params.set("cruce_to", cruceTo);
    if (conNotificacion) params.set("con_notificacion", "1");
    if (medioPago === "WOMPI%" && wompiTipo) params.set("wompi_tipo", wompiTipo);
    return params;
  };

  const downloadExcel = async () => {
    setDropdownOpen(false);
    setLoading(true);
    setFetchError("");
    try {
      const res  = await fetch(`/api/cartera-preventiva/download?${buildDownloadParams()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descargar");
      const allRows = json.data || [];
      if (json.truncated) {
        setFetchError("Se descargaron las primeras 50,000 filas. Usa los filtros para acotar la búsqueda.");
      }
      const ws = XLSX.utils.json_to_sheet(allRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Cartera Preventiva");
      XLSX.writeFile(wb, `cartera_preventiva_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
      const res  = await fetch(`/api/cartera-preventiva/download?${buildDownloadParams()}`);
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
      a.download = `cartera_preventiva_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
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

  const fmt = (v: string | null) => v || "—";
  const fmtMonto = (v: number | null) =>
    v != null ? new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(v) : "—";

  const PANEL = "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";
  const INPUT = "border border-black/10 bg-gray-50/60 rounded-xl px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors";

  // Diferencia (§4.9): pasa a poder ser positiva (saldo a favor, pagó de más)
  // con la Fase 8 de matching-test. Antes solo era negativa (debe) o 0 (exacto).
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
    if (row.diferencia != null && row.diferencia > 0) {
      return <span className="bg-teal-50 text-teal-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">Saldo a favor: {fmtMonto(row.diferencia)}</span>;
    }
    return <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">—</span>;
  };

  const isPagoParcial = (row: CarteraPreventivaRow) => row.diferencia != null && row.diferencia < 0;
  const isSaldoFavor = (row: CarteraPreventivaRow) => row.diferencia != null && row.diferencia > 0;

  // Spec Sobrantes-Excedentes §2: notificacion reemplaza las etiquetas viejas
  // de Fase 8 ('1 CUOTA + ABONO' etc, que ya no se producen) por 3 valores
  // nuevos con badge propio. Cualquier otro valor (incluidas esas etiquetas
  // viejas, si quedara alguna fila sin reprocesar) se muestra como texto plano.
  const notificacionBadge = (row: CarteraPreventivaRow) => {
    if (row.notificacion === "SOBRANTE") {
      return <span className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">SOBRANTE</span>;
    }
    if (row.notificacion === "EXCEDENTE") {
      return <span className="bg-purple-50 text-purple-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">EXCEDENTE</span>;
    }
    if (row.notificacion === "CONDONADO") {
      return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="bg-emerald-50 text-emerald-700 text-xs px-2 py-0.5 rounded-full">CONDONADO</span>
          {row.diferencia != null && <span className="text-xs text-gray-500">{fmtMonto(Math.abs(row.diferencia))}</span>}
        </span>
      );
    }
    // Regla #5 (Spec Auto Cartera): cuota nueva generada cuando un pago dejó
    // un faltante >= $50k tras cerrar lo que sí alcanzó a cubrir.
    if (row.notificacion === "FALTA DE PAGO") {
      return <span className="bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">FALTA DE PAGO</span>;
    }
    // Regla #8: cierre manual ya aplicado por el pipeline (valor_pago =
    // valor_a_cobrar, medio_pago = 'Cartera').
    if (row.notificacion === "CARTERA") {
      return <span className="bg-slate-100 text-slate-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">CARTERA</span>;
    }
    return <span className="text-gray-500 text-xs whitespace-nowrap">{fmt(row.notificacion)}</span>;
  };

  // Spec Sobrantes-Excedentes §1: la decisión humana del modelo A/B. Aparece
  // solo cuando la decisión cambia algo (SOBRANTE→EXCEDENTE, o faltante→
  // condonar); en una fila sin discrepancia no hace falta. Toggle reversible:
  // marcar de nuevo lo pone en false y el pipeline revierte a modo A.
  const necesitaUltimaCuota = (row: CarteraPreventivaRow) =>
    row.notificacion === "SOBRANTE" || (row.diferencia != null && row.diferencia < 0);

  const rowTint = (row: CarteraPreventivaRow) => {
    if (!row.fecha_pago) return "";
    if (row.diferencia === 0) return "bg-emerald-50/30";
    if (row.diferencia != null && row.diferencia < 0) return "bg-orange-50/30";
    if (row.diferencia != null && row.diferencia > 0) return "bg-teal-50/30";
    return "";
  };

  // El pipeline corre 1 vez al día; las acciones de confirmación de esta
  // vista (asociar pago, cerrar cartera, corregir valor cuota) deben poder
  // reprocesarse de inmediato en vez de esperar al cron (spec §6).
  const { fireTrigger, reprocesoBadge } = useReproceso(() => fetchData(page));

  const toggleAsociarPanel = async (row: CarteraPreventivaRow) => {
    const doc = row.cruce_access;
    const willOpen = !asociarOpen[doc];
    setAsociarOpen((prev) => ({ ...prev, [doc]: willOpen }));
    if (willOpen && !asociarData[doc]) {
      setAsociarLoading((prev) => ({ ...prev, [doc]: true }));
      setAsociarError((prev) => ({ ...prev, [doc]: "" }));
      try {
        const res  = await fetch(`/api/cartera-preventiva/asociar?documento=${encodeURIComponent(doc)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al cargar candidatos");
        setAsociarData((prev) => ({ ...prev, [doc]: { inscripciones: json.inscripciones || [], pagos: json.pagos || [] } }));
      } catch (err) {
        setAsociarError((prev) => ({ ...prev, [doc]: err instanceof Error ? err.message : "Error inesperado" }));
      } finally {
        setAsociarLoading((prev) => ({ ...prev, [doc]: false }));
      }
    }
  };

  const handleAsociar = async (doc: string, pago: PagoAsociable, inscripcion: InscripcionPendiente, monto: number) => {
    const actionKey = `${pago.matching_key}:${inscripcion.llave}`;
    setRowSaving(actionKey);
    setAsociarError((prev) => ({ ...prev, [doc]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/asociar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matching_key: pago.matching_key, llave: inscripcion.llave, monto }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al asociar");
      setAsociarData((prev) => {
        const current = prev[doc];
        if (!current) return prev;
        const pagos = current.pagos
          .map((p) => p.matching_key === pago.matching_key ? { ...p, restante: p.restante - monto } : p)
          .filter((p) => p.restante > 0.01);
        return { ...prev, [doc]: { ...current, pagos } };
      });
      setAsociarMessage((prev) => ({ ...prev, [doc]: "Asociación guardada. Se aplicará en el próximo cruce." }));
      fireTrigger();
    } catch (err) {
      setAsociarError((prev) => ({ ...prev, [doc]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const toggleCierrePanel = (row: CarteraPreventivaRow) => {
    setCierreOpen((prev) => ({ ...prev, [row.llave]: !prev[row.llave] }));
    if (!cierreFecha[row.llave]) {
      setCierreFecha((prev) => ({ ...prev, [row.llave]: new Date().toISOString().slice(0, 10) }));
    }
  };

  const handleCerrarCartera = async (row: CarteraPreventivaRow) => {
    const fecha = cierreFecha[row.llave] || new Date().toISOString().slice(0, 10);
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const valorCuota = Number(cuotaEdits[row.llave] ?? row.valor_cuota);
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llave: row.llave,
          cerrado_manual: true,
          fecha_pago_manual: fecha,
          medio_pago_manual: "Cartera",
          valor_pago_manual: valorCuota,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cerrar la cartera");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Cierre guardado. Se reflejará en el próximo cruce." }));
      setCierreOpen((prev) => ({ ...prev, [row.llave]: false }));
      fireTrigger();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #8 (Spec Auto Cartera): reabrir una cuota cerrada a mano — limpia
  // el override (cerrado_manual=false, fecha_pago_manual=null) para que el
  // pipeline la vuelva a poner pendiente en su próxima corrida.
  const handleReabrirCartera = async (row: CarteraPreventivaRow) => {
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, cerrado_manual: false, fecha_pago_manual: null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al reabrir");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Reapertura guardada. Se reflejará en el próximo cruce." }));
      fireTrigger();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleSaveValorCuota = async (row: CarteraPreventivaRow) => {
    const nuevo = Number(cuotaEdits[row.llave]);
    if (!Number.isFinite(nuevo) || nuevo === row.valor_cuota) return;
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, valor_cuota_manual: nuevo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar el valor de cuota");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Valor de cuota corregido. Se reflejará en el próximo cruce." }));
      fireTrigger();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleToggleUltimaCuota = async (row: CarteraPreventivaRow) => {
    const nuevoValor = !ultimaCuotaLlaves.has(row.llave);
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, es_ultima_cuota: nuevoValor }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar");
      setUltimaCuotaLlaves((prev) => {
        const next = new Set(prev);
        if (nuevoValor) next.add(row.llave); else next.delete(row.llave);
        return next;
      });
      setRowMessage((prev) => ({ ...prev, [row.llave]: nuevoValor ? "Marcada como última cuota. Se reflejará en el próximo cruce." : "Desmarcada. Se reflejará en el próximo cruce." }));
      fireTrigger();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #7: asocia un saldo a favor puntual (una fila del ledger) a la
  // cuota destino. El cierre lo escribe el pipeline en su próxima corrida —
  // acá solo se decrementa el disponible local para feedback inmediato.
  const handleAsociarSaldo = async (row: CarteraPreventivaRow, saldo: SaldoFavorRow, monto: number) => {
    const actionKey = `saldo:${saldo.id}:${row.llave}`;
    setRowSaving(actionKey);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/asociar-saldo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saldo_id: saldo.id, llave: row.llave, monto }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al asociar el saldo");
      setSaldosFavor((prev) => prev
        .map((s) => s.id === saldo.id ? { ...s, disponible: s.disponible - monto } : s)
        .filter((s) => s.disponible > 0.01));
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Saldo asociado. Se aplicará en el próximo cruce." }));
      fireTrigger();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #3: trae los pagos asociados a esta cuota para poder descartar uno.
  const toggleDescartarPanel = async (row: CarteraPreventivaRow) => {
    const willOpen = !descartarOpen[row.llave];
    setDescartarOpen((prev) => ({ ...prev, [row.llave]: willOpen }));
    if (willOpen && !descartarData[row.llave]) {
      setDescartarLoading((prev) => ({ ...prev, [row.llave]: true }));
      setDescartarError((prev) => ({ ...prev, [row.llave]: "" }));
      try {
        const res  = await fetch(`/api/cartera-preventiva/asociaciones?llave=${encodeURIComponent(row.llave)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al cargar pagos asociados");
        setDescartarData((prev) => ({ ...prev, [row.llave]: json.data || [] }));
      } catch (err) {
        setDescartarError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
      } finally {
        setDescartarLoading((prev) => ({ ...prev, [row.llave]: false }));
      }
    }
  };

  const handleDescartarPago = async (row: CarteraPreventivaRow, asociacion: AsociacionRow) => {
    setRowSaving(`descarte:${asociacion.id}`);
    setDescartarError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/descartar-pago", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asociacion_id: asociacion.id,
          llave: row.llave,
          matching_key: asociacion.matching_key,
          documento: row.cruce_access,
          correo: row.correo,
          cliente: row.cliente,
          inscrip: row.inscrip,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al descartar el pago");
      setDescartarData((prev) => ({ ...prev, [row.llave]: (prev[row.llave] || []).filter((a) => a.id !== asociacion.id) }));
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Pago descartado. La cuota vuelve a pendiente en el próximo cruce." }));
      fetchSaldosFavor();
      fireTrigger();
    } catch (err) {
      setDescartarError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #6: irreversible desde la UI — las verificaciones se hacen antes de
  // apretar, tal como advierte el spec.
  const handleActivarCartera = async () => {
    if (!confirm(`¿Activar la cartera nueva (${stagingCount.toLocaleString("es-CO")} cuotas)? La versión activa actual se archivará. Esta acción es irreversible desde esta pantalla.`)) return;
    setActivando(true);
    setActivarError("");
    setActivarMessage("");
    try {
      const res  = await fetch("/api/cartera-preventiva/activar", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al activar la cartera");
      setActivarMessage("Cartera nueva activada. Actualizando la vista...");
      await fetchStagingStatus();
      fetchData(1);
    } catch (err) {
      setActivarError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setActivando(false);
    }
  };

  return (
    <div className="p-5 pb-8 space-y-4">
      {reprocesoBadge}
      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <h1 className="text-lg font-semibold text-gray-900">Cartera Preventiva</h1>
      </div>

      {stagingCount > 0 && (
        <div className="animate-slide-down bg-amber-50 border border-amber-200/80 rounded-2xl px-6 py-3.5 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm font-medium text-amber-900">
              Hay una cartera nueva pendiente de cargar ({stagingCount.toLocaleString("es-CO")} cuotas)
            </p>
            <p className="text-xs text-amber-700 mt-0.5">Al activarla, la versión actual se archiva. Es irreversible desde esta pantalla — verifica antes de confirmar.</p>
            {activarMessage && <p className="text-xs text-green-700 mt-1">{activarMessage}</p>}
            {activarError && <p className="text-xs text-red-600 mt-1">{activarError}</p>}
          </div>
          <button
            onClick={handleActivarCartera}
            disabled={activando}
            className="text-sm px-3.5 py-1.5 rounded-full bg-amber-600 text-white hover:bg-amber-700 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 whitespace-nowrap"
          >
            {activando ? "Activando..." : "Cargar Cartera"}
          </button>
        </div>
      )}

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
          <select
            value={medioPago}
            onChange={(e) => {
              setMedioPago(e.target.value);
              if (e.target.value !== "WOMPI%") setWompiTipo("");
              setPage(1);
            }}
            className={INPUT}
          >
            <option value="" className="text-gray-900">Todos los medios de pago</option>
            {medios.map((m) => (
              <option key={m.value} value={m.value} className="text-gray-900">{m.label}</option>
            ))}
          </select>
          <select
            value={wompiTipo}
            onChange={(e) => { setWompiTipo(e.target.value); setPage(1); }}
            disabled={medioPago !== "WOMPI%"}
            className={`${INPUT} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <option value="" className="text-gray-900">Todos (Wompi)</option>
            <option value="automatico" className="text-gray-900">Automáticos</option>
            <option value="manual" className="text-gray-900">Manuales</option>
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
          <div className="flex items-center gap-2">
            <span className="font-medium">Fecha Pago</span>
            <input type="date" value={payFrom} onChange={(e) => { setPayFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={payTo} onChange={(e) => { setPayTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pagoParcial}
              onChange={(e) => { setPagoParcial(e.target.checked); setPage(1); }}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
            />
            <span className="font-medium">Solo pago parcial</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="font-medium">Día del Cruce</span>
            <input type="date" value={cruceFrom} onChange={(e) => { setCruceFrom(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
            <span>→</span>
            <input type="date" value={cruceTo} onChange={(e) => { setCruceTo(e.target.value); setPage(1); }}
              className={`${INPUT} py-1`} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={conNotificacion}
              onChange={(e) => { setConNotificacion(e.target.checked); setPage(1); }}
              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
            />
            <span className="font-medium">Con notificación de pago de más</span>
          </label>
          {(search || estado !== "todas" || vencFrom || vencTo || pagoParcial || medioPago || payFrom || payTo || cruceFrom || cruceTo || conNotificacion || wompiTipo) && (
            <button
              onClick={() => { setSearch(""); setEstado("todas"); setVencFrom(""); setVencTo(""); setPagoParcial(false); setMedioPago(""); setPayFrom(""); setPayTo(""); setCruceFrom(""); setCruceTo(""); setConNotificacion(false); setWompiTipo(""); setPage(1); }}
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

      <div className={`${PANEL} animate-fade-in [animation-delay:100ms] overflow-hidden`}>
        <div ref={tableContainerRef} className="overflow-auto max-h-[65vh]">
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
                <th className="px-4 py-3 font-medium whitespace-nowrap">Medio de Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Valor Pago</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 1</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Código Trans. 2</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Correo Electrónico</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Notificación</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Diferencia</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Documento</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Estado</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Acciones</th>
              </tr>
            </thead>
            <tbody key={page} className="divide-y divide-gray-100 animate-fade-in">
              {loading && data.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 21 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${60 + (i * j * 7) % 40}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={21} className="text-center py-12 text-gray-400">No hay registros</td>
                </tr>
              ) : (
                data.map((row) => {
                  const parcial = isPagoParcial(row);
                  const saldoFavor = isSaldoFavor(row);
                  const pendiente = !row.fecha_pago;
                  const saving = rowSaving === row.llave;
                  const cuotaValue = cuotaEdits[row.llave] ?? String(row.valor_cuota);
                  const cuotaChanged = cuotaValue.trim() !== "" && Number(cuotaValue) !== row.valor_cuota && !Number.isNaN(Number(cuotaValue));
                  const puedeAsociar = multiInscripcionDocs.has(row.cruce_access);
                  // Regla #4/#7: mensaje + botón de asociar saldo a favor —
                  // no en la cuota que originó el saldo (esa ya muestra su
                  // propio badge "Saldo a favor"), solo en las que necesitan
                  // dinero (pendiente o pago parcial).
                  const grupoKey = `${row.cruce_access}|${row.correo}`;
                  const grupo = saldoPorGrupo.get(grupoKey);
                  const esOrigenSaldo = !!grupo?.rows.some((s) => s.llave_origen === row.llave);
                  const necesitaDinero = pendiente || parcial;
                  const puedeAsociarSaldo = !!grupo && grupo.total > 0 && !esOrigenSaldo && necesitaDinero;
                  const cuotaRestante = pendiente ? row.valor_a_cobrar : Math.abs(row.diferencia ?? 0);
                  // Regla #3: descartar solo tiene sentido sobre un pago real
                  // ya aplicado — un cierre manual de cartera no tiene pago
                  // asociado que descartar.
                  const puedeDescartar = !pendiente && row.medio_pago !== "Cartera" && row.notificacion !== "CARTERA";
                  return (
                  <tr key={row.id} className={`hover:bg-gray-50/70 transition-colors duration-100 align-top ${rowTint(row)}`}>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.llave)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.sistema_financiero)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.inscrip)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cliente)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.moneda)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.fecha_vencimiento)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          value={cuotaValue}
                          onChange={(e) => setCuotaEdits((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                          disabled={saving}
                          className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                        />
                        {cuotaChanged && (
                          <button
                            onClick={() => handleSaveValorCuota(row)}
                            disabled={saving}
                            title="Guardar corrección de valor de cuota"
                            className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            ✓
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_a_cobrar)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.programa)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.fecha_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.medio_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtMonto(row.valor_pago)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_1)}</td>
                    <td className="px-4 py-2.5 text-gray-700">{fmt(row.codigo_transaccion_2)}</td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className="text-gray-500">{fmt(row.correo_elec)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">{notificacionBadge(row)}</td>
                    <td className={`px-4 py-2.5 text-gray-700 whitespace-nowrap ${parcial ? "bg-orange-50/60" : saldoFavor ? "bg-teal-50/60" : ""}`}>
                      <div className="flex items-center gap-1">
                        {parcial && <span title="Pago parcial: queda saldo pendiente" className="text-orange-600 text-xs">⚠️</span>}
                        {saldoFavor && <span title="Saldo a favor: pagó de más" className="text-teal-600 text-xs">✓</span>}
                        <span>{fmtMonto(row.diferencia)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cruce_access)}</td>
                    <td className="px-4 py-2.5">{paymentBadge(row)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-1 min-w-[160px]">
                        {necesitaUltimaCuota(row) && (
                          <button
                            onClick={() => handleToggleUltimaCuota(row)}
                            disabled={saving}
                            title="Marca que esta es la última cuota de la inscripción (modo B): un sobrante pasa a excedente final, un faltante se condona hasta $50k"
                            className={`text-xs px-2 py-1 rounded-lg border active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 ${
                              ultimaCuotaLlaves.has(row.llave)
                                ? "bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700"
                                : "border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                            }`}
                          >
                            {ultimaCuotaLlaves.has(row.llave) ? "✓ Última cuota" : "Es la última cuota"}
                          </button>
                        )}
                        {pendiente && (
                          <button
                            onClick={() => toggleCierrePanel(row)}
                            disabled={saving}
                            className="text-xs px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            {cierreOpen[row.llave] ? "Ocultar cierre" : "Cerrar cartera"}
                          </button>
                        )}
                        {!pendiente && row.notificacion === "CARTERA" && (
                          <button
                            onClick={() => handleReabrirCartera(row)}
                            disabled={saving}
                            title="Deshace el cierre manual — la cuota vuelve a pendiente en el próximo cruce"
                            className="text-xs px-2 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            Reabrir
                          </button>
                        )}
                        {cierreOpen[row.llave] && (
                          <div className="animate-fade-in bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1.5">
                            <label className="block text-[11px] text-gray-500">Fecha de pago</label>
                            <input
                              type="date"
                              value={cierreFecha[row.llave] || ""}
                              onChange={(e) => setCierreFecha((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                            />
                            <p className="text-[11px] text-gray-400">Medio: Cartera · Valor: {fmtMonto(Number(cuotaEdits[row.llave] ?? row.valor_cuota))}</p>
                            <button
                              onClick={() => handleCerrarCartera(row)}
                              disabled={saving}
                              className="w-full text-xs px-2 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              {saving ? "Guardando..." : "Confirmar cierre"}
                            </button>
                          </div>
                        )}
                        {puedeAsociar && pendiente && (
                          <button
                            onClick={() => toggleAsociarPanel(row)}
                            disabled={saving}
                            className="text-xs px-2 py-1 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            {asociarOpen[row.cruce_access] ? "Ocultar asociar" : "⚠️ Asociar"}
                          </button>
                        )}
                        {asociarOpen[row.cruce_access] && (
                          <div className="animate-fade-in bg-amber-50/60 border border-amber-200/80 rounded-lg p-2 space-y-1.5 w-64">
                            {asociarLoading[row.cruce_access] ? (
                              <p className="text-xs text-gray-500">Cargando...</p>
                            ) : asociarError[row.cruce_access] ? (
                              <p className="text-xs text-red-600">{asociarError[row.cruce_access]}</p>
                            ) : (
                              <>
                                <p className="text-[11px] text-amber-800">
                                  Hay {asociarData[row.cruce_access]?.pagos.length ?? 0} pago(s) de este documento, falta asociar a una inscripción.
                                </p>
                                {(asociarData[row.cruce_access]?.pagos || []).map((pago) => (
                                  <div key={pago.matching_key} className="bg-white border border-gray-200 rounded-lg p-1.5 space-y-1">
                                    <p className="text-[11px] text-gray-600">
                                      {fmt(pago.transaction_code_1)} · {fmt(pago.payment_date)} · restante {fmtMonto(pago.restante)}
                                    </p>
                                    {(asociarData[row.cruce_access]?.inscripciones || []).map((ins) => {
                                      const exacto = Math.abs(ins.valor_a_cobrar - pago.restante) < 1;
                                      const actionKey = `${pago.matching_key}:${ins.llave}`;
                                      const savingAction = rowSaving === actionKey;
                                      const otroValorKey = `${pago.matching_key}:${ins.llave}`;
                                      return (
                                        <div key={ins.llave} className="flex items-center justify-between gap-1 text-[11px]">
                                          <span className={exacto ? "text-emerald-700 font-medium" : "text-gray-600"}>
                                            {ins.inscrip} ({fmt(ins.sistema_financiero)}) — {fmtMonto(ins.valor_a_cobrar)}
                                            {exacto && " ✓ calza"}
                                          </span>
                                          <div className="flex items-center gap-1">
                                            <button
                                              onClick={() => handleAsociar(row.cruce_access, pago, ins, pago.restante)}
                                              disabled={savingAction}
                                              className="px-1.5 py-0.5 rounded bg-brand-700 text-white hover:bg-brand-800 disabled:opacity-50"
                                            >
                                              Todo
                                            </button>
                                            <input
                                              type="number"
                                              placeholder="otro $"
                                              value={montoOtroValor[otroValorKey] || ""}
                                              onChange={(e) => setMontoOtroValor((prev) => ({ ...prev, [otroValorKey]: e.target.value }))}
                                              className="w-14 border border-gray-300 rounded px-1 py-0.5"
                                            />
                                            <button
                                              onClick={() => {
                                                const monto = Number(montoOtroValor[otroValorKey]);
                                                if (Number.isFinite(monto) && monto > 0) handleAsociar(row.cruce_access, pago, ins, monto);
                                              }}
                                              disabled={savingAction}
                                              className="px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                            >
                                              OK
                                            </button>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                ))}
                                {asociarMessage[row.cruce_access] && (
                                  <p className="text-[11px] text-green-700">{asociarMessage[row.cruce_access]}</p>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {puedeAsociarSaldo && (
                          <div className="bg-teal-50/60 border border-teal-200/80 rounded-lg p-1.5 space-y-1">
                            <p className="text-[11px] text-teal-800">
                              Esta inscripción tiene un saldo a favor de {fmtMonto(grupo!.total)}
                            </p>
                            <button
                              onClick={() => setAsociarSaldoOpen((prev) => ({ ...prev, [row.llave]: !prev[row.llave] }))}
                              disabled={saving}
                              className="text-xs px-2 py-1 rounded-lg border border-teal-300 text-teal-700 hover:bg-teal-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              {asociarSaldoOpen[row.llave] ? "Ocultar" : "Asociar pago"}
                            </button>
                            {asociarSaldoOpen[row.llave] && (
                              <div className="animate-fade-in space-y-1 pt-1">
                                {grupo!.rows.map((saldo) => {
                                  const otroKey = `saldo:${saldo.id}:${row.llave}`;
                                  const savingAction = rowSaving === otroKey;
                                  const montoTodo = Math.min(saldo.disponible, cuotaRestante || saldo.disponible);
                                  return (
                                    <div key={saldo.id} className="bg-white border border-gray-200 rounded-lg p-1.5 space-y-1">
                                      <p className="text-[11px] text-gray-600">
                                        {fmt(saldo.cliente)} · {fmt(saldo.fecha)} · disponible {fmtMonto(saldo.disponible)}
                                      </p>
                                      <div className="flex items-center gap-1 text-[11px]">
                                        <button
                                          onClick={() => handleAsociarSaldo(row, saldo, montoTodo)}
                                          disabled={savingAction}
                                          className="px-1.5 py-0.5 rounded bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-50"
                                        >
                                          {cuotaRestante && cuotaRestante < saldo.disponible ? "Todo lo que falta" : "Todo"}
                                        </button>
                                        <input
                                          type="number"
                                          placeholder="otro $"
                                          value={saldoOtroValor[otroKey] || ""}
                                          onChange={(e) => setSaldoOtroValor((prev) => ({ ...prev, [otroKey]: e.target.value }))}
                                          className="w-16 border border-gray-300 rounded px-1 py-0.5"
                                        />
                                        <button
                                          onClick={() => {
                                            const monto = Number(saldoOtroValor[otroKey]);
                                            if (Number.isFinite(monto) && monto > 0) handleAsociarSaldo(row, saldo, monto);
                                          }}
                                          disabled={savingAction}
                                          className="px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                        >
                                          OK
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        {puedeDescartar && (
                          <button
                            onClick={() => toggleDescartarPanel(row)}
                            disabled={saving}
                            className="text-xs px-2 py-1 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                          >
                            {descartarOpen[row.llave] ? "Ocultar descartar" : "Descartar pago"}
                          </button>
                        )}
                        {descartarOpen[row.llave] && (
                          <div className="animate-fade-in bg-red-50/60 border border-red-200/80 rounded-lg p-2 space-y-1.5 w-64">
                            {descartarLoading[row.llave] ? (
                              <p className="text-xs text-gray-500">Cargando...</p>
                            ) : descartarError[row.llave] ? (
                              <p className="text-xs text-red-600">{descartarError[row.llave]}</p>
                            ) : (descartarData[row.llave] || []).length === 0 ? (
                              <p className="text-[11px] text-gray-500">No hay pagos asociados a descartar.</p>
                            ) : (
                              (descartarData[row.llave] || []).map((asociacion) => {
                                const savingAction = rowSaving === `descarte:${asociacion.id}`;
                                return (
                                  <div key={asociacion.id} className="bg-white border border-gray-200 rounded-lg p-1.5 flex items-center justify-between gap-2">
                                    <p className="text-[11px] text-gray-600">
                                      {fmt(asociacion.transaction_code_1)} · {fmt(asociacion.payment_date)} · {fmtMonto(asociacion.monto)}
                                    </p>
                                    <button
                                      onClick={() => handleDescartarPago(row, asociacion)}
                                      disabled={savingAction}
                                      className="text-[11px] px-1.5 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                                    >
                                      {savingAction ? "..." : "Descartar"}
                                    </button>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                        {rowMessage[row.llave] && <span className="text-[11px] text-green-700">{rowMessage[row.llave]}</span>}
                        {rowError[row.llave] && <span className="text-[11px] text-red-600">{rowError[row.llave]}</span>}
                        {!pendiente && !necesitaUltimaCuota(row) && !cierreOpen[row.llave] && !puedeDescartar && !puedeAsociarSaldo && !rowMessage[row.llave] && (
                          <span className="text-xs text-gray-400">—</span>
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
    </div>
  );
}
