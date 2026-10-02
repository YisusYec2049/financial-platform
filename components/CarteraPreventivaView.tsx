"use client";

import { Fragment, useEffect, useState, useCallback, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { useSessionState } from "@/lib/useSessionState";
import { useReproceso } from "@/lib/useReproceso";
import { parseMonto, formatMonto } from "@/lib/monto";
import { esPagoSinAplicar } from "@/lib/pagoSinAplicar";
// El mismo texto con el que las rutas rechazan (409) una cuota declarada pagada por
// Cartera: acá se muestra ANTES de apretar. Una sola copia a propósito — dos textos
// para la misma causa se desincronizan. `lib/cerradasManual` solo importa un TIPO del
// cliente de servidor (`import type`, que se borra al compilar), así que nada de
// `next/headers` entra al navegador.
import { ERROR_CERRADA_POR_CARTERA } from "@/lib/cerradasManual";

// Solo pregunta a Drive si llegó cartera nueva: corre sync_cartera.py y nada
// más (~4 s) vía /api/cartera-preventiva/sync. NO recalcula el cruce — eso
// sigue siendo "Actualizar cruce" (/api/cruce/trigger, ~3 min). Vive acá, junto
// al banner de staging, porque es donde se ve el resultado: si el Excel traía
// cartera nueva, queda en staging esperando a "Cargar Cartera" (este botón NO
// activa nada). El polling sigue siendo el de /api/cruce/trigger/status: el
// sync comparte el carril del pipeline, así que se reporta ahí igual.
function BuscarArchivosButton({ onDone }: { onDone: () => Promise<number | null> }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError]     = useState("");
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const antesRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const finish = useCallback(async (exitCode: number, logTail: string) => {
    stopPolling();
    setRunning(false);
    const despues = await onDone();
    if (exitCode !== 0) {
      setError(`La búsqueda terminó con errores${logTail ? `:\n${logTail.slice(-800)}` : "."}`);
      return;
    }
    // Si el conteo de staging no se movió, Drive no traía nada nuevo. Decirlo
    // explícitamente: un botón que termina en silencio es el problema original.
    if (antesRef.current !== null && despues !== null && despues === antesRef.current) {
      setMessage(despues > 0
        ? "No había archivos nuevos en Drive. Sigue pendiente la cartera que ya estaba en staging."
        : "Listo. No había archivos nuevos en Drive.");
    } else if (despues && despues > 0) {
      setMessage(`Listo. Llegó cartera nueva (${despues.toLocaleString("es-CO")} cuotas) — revisa el banner para cargarla.`);
    } else {
      setMessage("Listo.");
    }
  }, [stopPolling, onDone]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch("/api/cruce/trigger/status");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar el estado");
        if (json.status !== "running") await finish(json.exit_code ?? 0, json.log_tail || "");
      } catch (err) {
        stopPolling();
        setRunning(false);
        setError(err instanceof Error ? err.message : "Error inesperado");
      }
    }, 3000);
  }, [stopPolling, finish]);

  // Re-enganche al montar: si ya hay una corrida en curso (la disparó otra
  // persona, u otra pestaña), seguirla en vez de dejar el botón habilitado.
  // El carril del VPS es uno solo, así que puede ser esta cadena o un reproceso.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const res  = await fetch("/api/cruce/trigger/status");
        const json = await res.json();
        if (!cancelado && res.ok && json.status === "running") {
          antesRef.current = null;
          setRunning(true);
          setMessage("Hay un proceso en curso, siguiéndolo...");
          startPolling();
        }
      } catch {
        // Sin status no hay nada que retomar: el botón queda utilizable.
      }
    })();
    return () => { cancelado = true; };
  }, [startPolling]);

  const handleClick = async () => {
    setRunning(true);
    setMessage("");
    setError("");
    try {
      antesRef.current = await onDone();
      const statusRes  = await fetch("/api/cruce/trigger/status");
      const statusJson = await statusRes.json();
      if (statusJson.status !== "running") {
        const res  = await fetch("/api/cartera-preventiva/sync", { method: "POST" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "No se pudo iniciar la búsqueda");
      }
      startPolling();
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : "Error inesperado");
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={running}
        title="Revisa si hay cartera nueva en Drive y la deja en espera. No recalcula el cruce ni activa la cartera: eso sigue siendo 'Cargar Cartera'."
        className="flex items-center gap-1.5 bg-emerald-600 text-white text-sm px-3.5 py-1.5 rounded-full shadow-sm hover:bg-emerald-700 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-60"
      >
        <svg className={`w-4 h-4 ${running ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        {running ? "Buscando..." : "Buscar archivos nuevos"}
      </button>
      {running && <span className="text-[11px] text-gray-500">Revisando Drive...</span>}
      {message && !running && <span className="text-[11px] text-gray-600 max-w-xs text-right">{message}</span>}
      {error && <span className="text-[11px] text-red-600 max-w-xs text-right whitespace-pre-wrap">{error}</span>}
    </div>
  );
}

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
  // Solo se llena cuando una persona cierra la cuota (botón "Cerrar Cuota" o
  // "Cerrar Cartera"): distingue una cuota cerrada de una que solo trae un
  // abono del Excel. Es la definición del filtro "Cerradas".
  pago_confirmado: number | null;
  diferencia: number | null;
  fecha_cruce: string | null;
  notificacion: string | null;
  // Cuántas cuotas distintas debe la inscripción de esta fila, sobre TODA la cartera.
  // Lo calcula la vista `cartera_preventiva_v` colapsando los renglones de una misma
  // cuota cobrada por partes ("llave" + "llave (fecha)"). Alimenta el filtro
  // "Inscripciones con varias cuotas".
  cuotas_inscripcion?: number | null;
  // Lo calcula GET /api/cartera-preventiva: esta fila es una "línea de deuda"
  // (llave de otra cuota + sufijo entre paréntesis) y su cuota original sigue
  // abierta. Mientras eso sea cierto la plata se asocia en la original — la
  // línea es solo el reflejo de su `diferencia` y el pipeline la baja solo.
  original_abierta?: boolean;
  // Lo calcula GET /api/cartera-preventiva, y SOLO para las cuotas cerradas por
  // Cartera: esa cuota tiene al menos un pago en `pago_asociaciones`. Es lo que
  // deja soltarlo desde la pantalla en el único caso donde eso hace falta (ver
  // `puedeDescartarCerradaPorCartera` más abajo).
  tiene_asociaciones?: boolean;
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
  cliente: string | null;
  valor_a_cobrar: number;
  valor_cuota: number;
  sistema_financiero: string | null;
  fecha_vencimiento: string;
  fecha_pago: string | null;
  diferencia: number | null;
};

// Lo que le falta de verdad a una cuota candidata del panel. Desde el 2026-08-21 la
// lista incluye cuotas que YA recibieron plata y quedaron cortas (las del aviso
// "PAGO SIN APLICAR"): ahí `valor_a_cobrar` sigue siendo el valor entero de la cuota,
// así que ofrecerlo como lo que debe se equivoca por varios ceros —$1.011.818 cuando
// faltan $11.818—. Mismo criterio que `cuotaRestante` en la fila.
const faltaDeCuota = (ins: InscripcionPendiente) =>
  ins.fecha_pago && ins.diferencia != null && ins.diferencia < 0
    ? Math.abs(ins.diferencia)
    : ins.valor_a_cobrar;

// Lo que se muestra al buscar el documento destino de un envío de saldo. Sale del
// MISMO GET del panel de asociar, que ya devuelve las inscripciones con cuota
// pendiente de un documento — no hizo falta ruta nueva.
type DestinoTraslado = {
  cliente: string | null;
  inscripciones: string[];
  debe: number;
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

// Polling del swap de versión de "Cargar Cartera" (§3). GRACE cubre el instante
// entre el POST y que el VPS marque la corrida como running.
const ACTIVAR_POLL_MS  = 3000;
const ACTIVAR_GRACE_MS = 10000;
const ACTIVAR_MAX_MS   = 5 * 60 * 1000;

export default function CarteraPreventivaView() {
  const [data, setData]                 = useState<CarteraPreventivaRow[]>([]);
  const [total, setTotal]               = useState(0);
  // Solo con el filtro de Diferencia puesto: ahí `total` cuenta CUOTAS y esto cuenta
  // los renglones que se ven (cada cuota arrastra sus líneas derivadas).
  const [renglones, setRenglones]       = useState<number | null>(null);
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
  const [multiCuota, setMultiCuota] = useSessionState("cartera_preventiva.multiCuota", false);
  const [pagoSinAplicar, setPagoSinAplicar] = useSessionState("cartera_preventiva.pagoSinAplicar", false);
  // "" | "falta" | "sobra" — ver lib/carteraDiferencia.ts
  const [diferencia, setDiferencia] = useSessionState("cartera_preventiva.diferencia", "");
  const [medios, setMedios]             = useState<{ label: string; value: string }[]>([]);
  const [fetchError, setFetchError]     = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [multiInscripcionDocs, setMultiInscripcionDocs] = useState<Set<string>>(new Set());
  const [ultimaCuotaLlaves, setUltimaCuotaLlaves] = useState<Set<string>>(new Set());
  // 🔴 Los pagos y los saldos disponibles son del DOCUMENTO —una sola consulta
  // sirve para todas sus cuotas— pero el panel trabaja sobre la CUOTA del cajón.
  // Por eso la caché va por `row.cruce_access` mientras lo que está abierto se
  // identifica por `llave` (`cajonLlave`). Cachear por cuota haría una consulta
  // por fila; abrir por documento era lo que expandía las 6 cuotas de una persona
  // a la vez, que es el defecto que se corrigió hoy.
  const [asociarData, setAsociarData]           = useState<Record<string, { inscripciones: InscripcionPendiente[]; pagos: PagoAsociable[] }>>({});
  const [asociarLoading, setAsociarLoading]     = useState<Record<string, boolean>>({});
  const [asociarError, setAsociarError]         = useState<Record<string, string>>({});
  const [montoOtroValor, setMontoOtroValor]     = useState<Record<string, string>>({});
  // Envío de saldo a otro documento. Todo va por pago (`${doc}:${matching_key}`),
  // que es la unidad sobre la que se decide: un pago puede cubrir a dos personas.
  const [enviarOpen, setEnviarOpen]             = useState<Record<string, boolean>>({});
  const [enviarDocInput, setEnviarDocInput]     = useState<Record<string, string>>({});
  const [enviarMontoInput, setEnviarMontoInput] = useState<Record<string, string>>({});
  const [enviarDestino, setEnviarDestino]       = useState<Record<string, DestinoTraslado | null>>({});
  const [enviarBuscando, setEnviarBuscando]     = useState<Record<string, boolean>>({});
  const [enviarError, setEnviarError]           = useState<Record<string, string>>({});
  const [cierreOpen, setCierreOpen]             = useState<Record<string, boolean>>({});
  const [cierreFecha, setCierreFecha]           = useState<Record<string, string>>({});
  const [cuotaEdits, setCuotaEdits]             = useState<Record<string, string>>({});
  const [vencEdits, setVencEdits]               = useState<Record<string, string>>({});
  const [pagoEdits, setPagoEdits]               = useState<Record<string, string>>({});
  const [rowSaving, setRowSaving]               = useState<string | null>(null);
  const [rowMessage, setRowMessage]             = useState<Record<string, string>>({});
  const [rowError, setRowError]                 = useState<Record<string, string>>({});
  const [saldosFavor, setSaldosFavor]           = useState<SaldoFavorRow[]>([]);
  // Ya no hay un `asociarSaldoOpen`: los saldos a favor son una SECCIÓN del panel de
  // asociar, no un panel aparte. Eran dos botones que abrían dos cosas distintas
  // sobre la misma fila (trampa 4 del spec).
  const [saldoOtroValor, setSaldoOtroValor]     = useState<Record<string, string>>({});
  const [descartarOpen, setDescartarOpen]       = useState<Record<string, boolean>>({});
  const [descartarData, setDescartarData]       = useState<Record<string, AsociacionRow[]>>({});
  const [descartarLoading, setDescartarLoading] = useState<Record<string, boolean>>({});
  const [descartarError, setDescartarError]     = useState<Record<string, string>>({});
  // "Descartar y marcar pagada por Cartera" (2026-08-31): suelta los pagos de la
  // cuota y la cierra por Cartera de un clic. Comparte los datos del panel de
  // descartar (misma consulta), pero su propio abierto/cerrado.
  const [descartarCerrarOpen, setDescartarCerrarOpen] = useState<Record<string, boolean>>({});
  // La cuota abierta en el CAJÓN lateral, por `llave`. Una sola a la vez: el cajón
  // es el sitio donde se trabaja una cuota, y dos abiertos no significarían nada.
  // Reemplaza al menú desplegable de la columna Acciones Y a la fila expandida que
  // había debajo — los cinco formularios viven ahora acá adentro.
  const [cajonLlave, setCajonLlave]             = useState<string | null>(null);
  const [stagingCount, setStagingCount]         = useState(0);
  const [activando, setActivando]               = useState(false);
  const [activarMessage, setActivarMessage]     = useState("");
  const [activarError, setActivarError]         = useState("");
  const [agregarOpen, setAgregarOpen]           = useState(false);
  const [agregarForm, setAgregarForm]           = useState({
    cruce_access: "", inscrip: "", fecha_vencimiento: "", valor_cuota: "",
    cliente: "", programa: "", correo: "", moneda: "COP", sistema_financiero: "SIST_F_NUEVO",
  });
  const [agregarInscripciones, setAgregarInscripciones] = useState<string[]>([]);
  const [agregarEnCartera, setAgregarEnCartera] = useState<string[]>([]);
  const [agregarBuscando, setAgregarBuscando]   = useState(false);
  const [agregarGuardando, setAgregarGuardando] = useState(false);
  const [agregarError, setAgregarError]         = useState("");
  const [agregarMessage, setAgregarMessage]     = useState("");
  const [cerrarDiaOpen, setCerrarDiaOpen]       = useState(false);
  const [cerrandoDia, setCerrandoDia]           = useState(false);
  const [cerrarDiaMessage, setCerrarDiaMessage] = useState("");
  const [cerrarDiaError, setCerrarDiaError]     = useState("");
  const searchTimeout                   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef              = useRef<AbortController | null>(null);
  // El contenedor con scroll de la tabla. Lo lee el efecto que conserva el borde
  // derecho cuando el cajón la angosta (más abajo), y es lo que hace falta para el
  // pendiente de devolver la tabla arriba al cambiar de página.
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
    if (multiCuota)   params.set("multi_cuota", "1");
    if (pagoSinAplicar) params.set("pago_sin_aplicar", "1");
    if (diferencia)   params.set("diferencia", diferencia);
    if (medioPago === "WOMPI%" && wompiTipo) params.set("wompi_tipo", wompiTipo);
    params.set("page", String(currentPage));

    try {
      const res  = await fetch(`/api/cartera-preventiva?${params}`, { signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cargar datos");
      setData(json.data || []);
      setTotal(json.count || 0);
      setRenglones(typeof json.renglones === "number" ? json.renglones : null);
      // Cambiar de página o de filtro puede llevarse la cuota que está abierta en
      // el cajón. Se cierra acá, no en un efecto: el cajón lee la fila de `data`,
      // y dejarlo abierto sobre una cuota que ya no está en pantalla mostraría
      // datos viejos — o lo reabriría solo al volver a esa página.
      setCajonLlave((prev) => prev && (json.data || []).some((r: CarteraPreventivaRow) => r.llave === prev) ? prev : null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setFetchError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }, [search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, multiCuota, pagoSinAplicar, diferencia, wompiTipo]);

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

  // Devuelve el conteo además de guardarlo: "Buscar archivos nuevos" lo compara
  // antes y después de la corrida para poder decir si Drive traía algo nuevo.
  const fetchStagingStatus = useCallback(async (): Promise<number | null> => {
    try {
      const res  = await fetch("/api/cartera-preventiva/staging-status");
      const json = await res.json();
      if (res.ok) { setStagingCount(json.count || 0); return json.count || 0; }
    } catch {
      // No bloquea la vista si falla — el banner simplemente no aparece.
    }
    return null;
  }, []);

  useEffect(() => {
    fetchMedios();
    fetchMultiInscripcion();
    fetchUltimaCuota();
    fetchSaldosFavor();
    fetchStagingStatus();
  }, [fetchMedios, fetchMultiInscripcion, fetchUltimaCuota, fetchSaldosFavor, fetchStagingStatus]);

  // Regla #4/#7 (revisada 30/07): documento es la señal FUERTE, correo la
  // débil. Basta con que coincida UNA de las dos — antes se exigían las dos
  // y eso dejaba invisibles los saldos de personas sin correo en cartera.
  const saldosPorDocumento = useMemo(() => {
    const map = new Map<string, SaldoFavorRow[]>();
    for (const s of saldosFavor) {
      const doc = (s.documento || "").trim();
      if (!doc) continue;
      if (!map.has(doc)) map.set(doc, []);
      map.get(doc)!.push(s);
    }
    return map;
  }, [saldosFavor]);

  // El correo solo empareja si PARECE un correo: en cartera hay valores
  // basura (ej. "0") que apuntan a 5 documentos distintos.
  const saldosPorCorreo = useMemo(() => {
    const map = new Map<string, SaldoFavorRow[]>();
    for (const s of saldosFavor) {
      const co = (s.correo || "").trim().toLowerCase();
      if (!co || !co.includes("@")) continue;
      if (!map.has(co)) map.set(co, []);
      map.get(co)!.push(s);
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
  }, [search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, cruceFrom, cruceTo, conNotificacion, multiCuota, diferencia, wompiTipo, fetchData]);


  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // El cajón se cierra con Escape. 🔴 NO se cierra al hacer clic fuera, y es la
  // decisión que lo define: es un cajón que NO bloquea la tabla (sin fondo
  // oscurecido), así que todo clic de afuera es alguien usando la tabla —
  // desplazándola, abriendo otra cuota, corrigiendo una fecha—. Cerrarlo ahí
  // borraría a mitad lo que se esté llenando.
  // ⚠️ Y no cierra el cajón si hay una ventana de confirmación encima ("Cerrar
  // Cartera", "Agregar cuota"): ahí Escape es para esa ventana, y cerrar el cajón
  // de atrás sería un efecto invisible sobre algo que nadie pidió tocar.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cerrarDiaOpen && !agregarOpen) setCajonLlave(null);
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [cerrarDiaOpen, agregarOpen]);

  // 🔴 Abrir el cajón le quita 26 rem de ancho VISIBLE a la tabla, y son 21
  // columnas `whitespace-nowrap`: lo que estaba pegado al borde derecho —la
  // columna Acciones, que es donde se acaba de apretar "Abrir"— se sale de la
  // vista. Se lee como que el cajón tapó la tabla, aunque la tabla termine 20 px
  // antes (medido sobre la captura del usuario: la tarjeta acaba en el mismo sitio
  // que las de arriba y lo que hay entre medio es la sombra del cajón).
  // Así que cuando el ancho cambia, el scroll se corre lo mismo: la tabla se
  // DESLIZA debajo del cajón en vez de perder sus últimas columnas.
  // ⚠️ Va con `ResizeObserver` y no al abrir/cerrar: el ancho tarda 300 ms en
  // llegar —es una transición— y hay que seguirlo fotograma a fotograma. Escribir
  // `scrollLeft` no cambia ningún tamaño, así que no se realimenta.
  // ⚠️ Y cubre de paso ensanchar la ventana o la barra lateral del shell, que
  // mueven el mismo ancho por otro motivo.
  useEffect(() => {
    const caja = tableContainerRef.current;
    if (!caja) return;
    let anchoPrevio = caja.clientWidth;
    const observador = new ResizeObserver(() => {
      const ancho = caja.clientWidth;
      const delta = anchoPrevio - ancho;
      anchoPrevio = ancho;
      if (!delta) return;
      const tope = caja.scrollWidth - ancho;
      caja.scrollLeft = Math.max(0, Math.min(tope, caja.scrollLeft + delta));
    });
    observador.observe(caja);
    return () => observador.disconnect();
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
    if (multiCuota)   params.set("multi_cuota", "1");
    if (pagoSinAplicar) params.set("pago_sin_aplicar", "1");
    if (diferencia)   params.set("diferencia", diferencia);
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
    // La cuota original de un pago parcial con faltante >= $50.000 lleva la
    // marca 'FALTA DE PAGO' (el faltante vive en `diferencia`, negativo). Su
    // estado real NO es "Pagada completa" ni "Saldo:" — es que le faltó el pago.
    // Va primero, para que gane sobre el chequeo de `diferencia < 0`.
    if (row.notificacion === "FALTA DE PAGO") {
      return <span className="bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded-full whitespace-nowrap">FALTA DE PAGO</span>;
    }
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
    // 'FALTA DE PAGO' ahora se muestra en el ESTADO de la cuota original
    // (`paymentBadge`), no en esta columna — la marca pasó de la cuota nueva
    // (la deuda) a la original, que es a la que le faltó el pago. La cuota
    // nueva viene con notificacion=NULL, así que aquí no debe aparecer.
    // `return null` explícito para que no caiga al texto plano de abajo.
    if (row.notificacion === "FALTA DE PAGO") {
      return null;
    }
    // El aviso del pipeline (2026-08-21): esta cuota quedó corta por menos del
    // umbral, así que su cuota de deuda no nació y el pago que llegó después NO se
    // aplica solo. Es el único aviso de la pantalla que pide una acción concreta
    // —asociar esa plata a mano—, así que no puede verse más apagado que un cierre
    // manual. Por PREFIJO: el monto viene pegado dentro del texto y cambia con él.
    if (esPagoSinAplicar(row.notificacion)) {
      return (
        <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded-full whitespace-nowrap font-medium">
          {row.notificacion}
        </span>
      );
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
  // Al terminar el recálculo hay que refrescar también el ledger: los saldos
  // los recalcula el pipeline, así que quedarse con la resta local de
  // handleAsociarSaldo dejaría el panel mostrando un número que ya no es.
  const { fireTrigger, reprocesoBadge, marcaFila } = useReproceso(() => { fetchData(page); fetchSaldosFavor(); });

  // Recarga los candidatos del panel desde el servidor. Se usa al abrirlo y
  // después de asociar: el decremento local del "restante" da feedback
  // inmediato, pero el valor_a_cobrar de las inscripciones solo se recalcula
  // releyendo — si no, el panel sigue mostrando lo que faltaba antes.
  const fetchAsociarData = useCallback(async (doc: string) => {
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
  }, []);


  // Asocia un pago del documento a la cuota de ESTA fila. Ya no recibe una
  // `InscripcionPendiente` elegida en una lista: la cuota destino es la fila, que es
  // lo que la persona contestó al apretar el botón. Antes se elegía "una random de
  // las que están ahí" y la plata se iba a otra cuota sin que nada avisara.
  //
  // El resultado va a `rowMessage`/`rowError` de la FILA, no a un mensaje por
  // documento: con el panel por cuota pueden estar abiertas dos cuotas de la misma
  // persona, y un mensaje por documento se vería en las dos.
  const handleAsociar = async (row: CarteraPreventivaRow, pago: PagoAsociable, monto: number) => {
    const doc = row.cruce_access;
    const actionKey = `${pago.matching_key}:${row.llave}`;
    setRowSaving(actionKey);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    setAsociarError((prev) => ({ ...prev, [doc]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/asociar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matching_key: pago.matching_key, llave: row.llave, monto }),
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
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Asociación guardada. Se aplica al terminar el recálculo." }));
      fetchAsociarData(doc);
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
      // El servidor revalida el sello, cuánto le queda al pago y que la cuota no
      // esté declarada pagada por Cartera, así que un rechazo suele significar que
      // este panel está desactualizado (otra pestaña, o el botón de al lado hace 14
      // segundos). Releer deja a la vista el estado real en vez de un panel que
      // sigue ofreciendo plata que ya no está.
      fetchAsociarData(doc);
    } finally {
      setRowSaving(null);
    }
  };

  // Buscar el documento destino antes de enviar. Reutiliza el GET del panel de
  // asociar: si el documento no tiene cuotas abiertas, `inscripciones` viene vacío
  // y eso es justamente lo que hay que enseñar — la plata no se podría usar allá.
  // El nombre a la vista es lo único que deja notar que se erró el documento.
  const handleBuscarDestino = async (key: string, documento: string) => {
    const doc = documento.trim();
    if (!doc) return;
    setEnviarBuscando((prev) => ({ ...prev, [key]: true }));
    setEnviarError((prev) => ({ ...prev, [key]: "" }));
    setEnviarDestino((prev) => ({ ...prev, [key]: null }));
    try {
      const res  = await fetch(`/api/cartera-preventiva/asociar?documento=${encodeURIComponent(doc)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al buscar el documento");
      const inscripciones = (json.inscripciones || []) as InscripcionPendiente[];
      setEnviarDestino((prev) => ({
        ...prev,
        [key]: {
          cliente: inscripciones.find((i) => i.cliente)?.cliente ?? null,
          inscripciones: [...new Set(inscripciones.map((i) => i.inscrip))],
          debe: inscripciones.reduce((a, i) => a + Number(faltaDeCuota(i) || 0), 0),
        },
      }));
    } catch (err) {
      setEnviarError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setEnviarBuscando((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Enviar plata de este pago al documento de OTRA persona. Queda como saldo a
  // favor de esa persona y allá se recoge con el botón "Asociar saldo" que ya
  // existe: son dos pasos a propósito, enviar y después asociar a la cuota que
  // corresponda. El servidor revalida las 6 condiciones dentro de la función de
  // base y responde 409; acá no se valida nada que allá no se vuelva a mirar.
  const handleEnviarSaldo = async (row: CarteraPreventivaRow, pago: PagoAsociable, documentoDestino: string, monto: number) => {
    const doc = row.cruce_access;
    const key = `${row.llave}:${pago.matching_key}`;
    setRowSaving(`enviar:${key}`);
    setEnviarError((prev) => ({ ...prev, [key]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/enviar-saldo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matching_key: pago.matching_key,
          documento_destino: documentoDestino.trim(),
          monto,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al enviar el saldo");
      setEnviarOpen((prev) => ({ ...prev, [key]: false }));
      setEnviarDestino((prev) => ({ ...prev, [key]: null }));
      setEnviarDocInput((prev) => ({ ...prev, [key]: "" }));
      setEnviarMontoInput((prev) => ({ ...prev, [key]: "" }));
      setRowMessage((prev) => ({
        ...prev,
        [row.llave]: `Se enviaron ${fmtMonto(monto)} al documento ${documentoDestino.trim()}. Allá aparece como saldo a favor, listo para asociar a una cuota.`,
      }));
      // El restante del pago bajó y el ledger tiene una fila nueva: hay que releer
      // los dos, o el panel sigue ofreciendo plata que ya se fue.
      fetchAsociarData(doc);
      fetchSaldosFavor();
    } catch (err) {
      setEnviarError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
      // Un rechazo casi siempre significa que este panel está viejo (otra pestaña,
      // o el botón de al lado hace unos segundos). Mismo criterio que handleAsociar.
      fetchAsociarData(doc);
    } finally {
      setRowSaving(null);
    }
  };

  // Enviar a otro documento un saldo a favor que YA está en el ledger (sobrante o
  // descarte). Es el camino del día a día, y NO lo cubre el envío del panel de
  // asociar: aquel manda el restante LIBRE del pago, y su fórmula descuenta el
  // ledger — así que en cuanto el sobrante se vuelve saldo a favor responde "a este
  // pago no le queda nada". Caso que lo destapó: un diplomado de 2 cupos pagado de
  // un solo giro, con el segundo cupo a nombre de otra cédula.
  //
  // La plata sale de la fila de origen y nace a nombre del destino con el MISMO
  // matching_key (el cuadre del pipeline es por pago, no por persona), en una sola
  // transacción dentro de `trasladar_saldo_favor()`. Allá se recoge con el botón
  // "Asociar saldo" que ya existe: son dos pasos a propósito.
  const handleEnviarSaldoFavor = async (
    row: CarteraPreventivaRow,
    saldo: SaldoFavorRow,
    key: string,
    documentoDestino: string,
    monto: number,
  ) => {
    setRowSaving(`enviar:${key}`);
    setEnviarError((prev) => ({ ...prev, [key]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/enviar-saldo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saldo_id: saldo.id,
          documento_destino: documentoDestino.trim(),
          monto,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al enviar el saldo");
      setEnviarOpen((prev) => ({ ...prev, [key]: false }));
      setEnviarDestino((prev) => ({ ...prev, [key]: null }));
      setEnviarDocInput((prev) => ({ ...prev, [key]: "" }));
      setEnviarMontoInput((prev) => ({ ...prev, [key]: "" }));
      setRowMessage((prev) => ({
        ...prev,
        [row.llave]: `Se enviaron ${fmtMonto(monto)} al documento ${documentoDestino.trim()}. Allá aparece como saldo a favor, listo para asociar a una cuota.`,
      }));
      fetchSaldosFavor();
    } catch (err) {
      setEnviarError((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Error inesperado" }));
      // Un rechazo casi siempre significa que esta pantalla está vieja (otra
      // pestaña, o el botón de al lado hace unos segundos). Mismo criterio que
      // handleAsociar: releer deja a la vista lo que de verdad hay.
      fetchSaldosFavor();
    } finally {
      setRowSaving(null);
    }
  };

  // Deshacer un envío: un documento mal escrito manda plata a la pantalla de un
  // desconocido. Solo mientras nadie la haya asociado — de eso se encarga el
  // servidor, que revalida que el saldo siga intacto y responde 409 si no.
  //
  // ⚠️ No es un borrado: si el envío salió de otra fila del ledger, la plata tiene
  // que VOLVER ahí (a esa fila se le restó el monto). Eso lo hace
  // `deshacer_traslado_saldo()` en una sola transacción.
  const handleDeshacerTraslado = async (row: CarteraPreventivaRow, saldo: SaldoFavorRow) => {
    const actionKey = `deshacer:${saldo.id}`;
    setRowSaving(actionKey);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/enviar-saldo/deshacer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saldo_id: saldo.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al deshacer el envío");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Envío deshecho. La plata volvió a donde estaba." }));
      fetchSaldosFavor();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
      fetchSaldosFavor();
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

  // `cartera_preventiva.pago` es text en el esquema real y puede traer decimales
  // del Excel ("485086.5"). Nada que ver con parseMonto (entrada del usuario).
  const numPago = (v: string | null): number => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : 0;
  };

  // El botón "Cerrar Cuota" (POST /api/cartera-preventiva/cerrar-cuota) se
  // eliminó el 2026-09-02 a pedido del área: en toda la historia se apretó 5
  // veces y 2 de esas hubo que deshacerlas por SQL, porque ese cierre no tiene
  // "Reabrir". No se pierde ninguna capacidad — el botón de bloque "Cerrar
  // Cartera" (cerrar-dia) hace exactamente la misma escritura — y la ruta se
  // deja en pie a propósito.

  const handleCerrarCartera = async (row: CarteraPreventivaRow) => {
    const fecha = cierreFecha[row.llave] || new Date().toISOString().slice(0, 10);
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const valorCuota = parseMonto(cuotaEdits[row.llave] ?? row.valor_cuota);
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
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Cierre guardado. Se refleja al terminar el recálculo." }));
      setCierreOpen((prev) => ({ ...prev, [row.llave]: false }));
      fireTrigger(row.llave);
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
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Reapertura guardada. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Reabrir el cierre DE VERDAD, el que tiene pago asignado ("Cerrar Cartera"
  // por bloque, o el viejo "Cerrar Cuota" por fila). Hasta hoy esas cuotas no
  // tenían salida desde la pantalla y había que destrabarlas por SQL. La ruta
  // aplica la inversa exacta de la fórmula del cierre y pone el Día del Cruce
  // de HOY, para que la cuota caiga en el cierre de mañana en vez de quedar
  // encerrada en su día viejo.
  // Reabrir no corrige nada más: las modificaciones las hace una persona.
  // ⚠️ Es otro camino que handleReabrirCartera a propósito: las cuotas cerradas
  // por Cartera también traen `pago_confirmado`, pero su cierre vive en un
  // override del que el pipeline es dueño (ver la guarda de la ruta).
  const handleReabrirCuota = async (row: CarteraPreventivaRow) => {
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/reabrir-cuota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al reabrir la cuota");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Cuota reabierta con el Día del Cruce de hoy. Se refleja al terminar el recálculo." }));
      // Seguro y conveniente: al quedar `pago_confirmado` en null el pipeline
      // vuelve a comparar la fila, y desde el 2026-10-01 no reescribe una que
      // no cambia nada (ni mira `fecha_cruce` al comparar), así que la fecha de
      // la reapertura sobrevive.
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  const handleSaveValorCuota = async (row: CarteraPreventivaRow) => {
    const nuevo = parseMonto(cuotaEdits[row.llave]);
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
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Valor de cuota corregido. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // La fecha corregida NO mueve plata ya aplicada: un pago se reparte una sola
  // vez en su vida (queda en pago_asociaciones). Lo que sí hace es ordenar los
  // pagos que entren DESPUÉS — el reparto llena siempre la cuota que vence
  // primero. Mover plata ya aplicada es a mano: descartar el pago y asociarlo
  // en la otra cuota.
  // Sin validar que la fecha sea futura ni que respete el orden de las demás
  // cuotas: corregir hacia atrás (10/09 → 10/08) es justamente el caso real.
  const handleSaveFechaVencimiento = async (row: CarteraPreventivaRow) => {
    const nueva = (vencEdits[row.llave] ?? "").trim();
    if (!nueva || nueva === row.fecha_vencimiento) return;
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, fecha_vencimiento_manual: nueva }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar la fecha de vencimiento");
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Fecha de vencimiento corregida. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // El abono que trae el Excel (columna PAGO) corregido a mano. Cuando ese
  // abono cubre la cuota entera, `valor a cobrar` queda en 0 y la cuota sale
  // del reparto: ningún pago que llegue después puede entrarle (caso del doc
  // 1038415208, cuota 3681PN46253). Poner 0 = "ese abono no existe"; vaciar la
  // casilla borra la corrección y vuelve a lo que dice el Excel.
  // Mismo patrón que valor de cuota y fecha de vencimiento: la app registra la
  // decisión en cartera_preventiva_overrides y el pipeline escribe
  // cartera_preventiva.pago y recalcula `valor a cobrar`. Nunca al revés.
  const handleSavePago = async (row: CarteraPreventivaRow, valor: string) => {
    const raw   = valor.trim();
    const nuevo = raw === "" ? null : parseMonto(raw);
    if (nuevo !== null && (!Number.isFinite(nuevo) || nuevo < 0)) return;
    // Un abono mayor a la cuota dejaría `valor a cobrar` en negativo, que
    // ninguna pantalla sabe mostrar. Se compara contra el valor guardado, no
    // contra el que pueda estar a medio escribir en la casilla de al lado.
    if (nuevo !== null && nuevo > row.valor_cuota) {
      setRowError((prev) => ({
        ...prev,
        [row.llave]: `El abono no puede superar el valor de la cuota (${fmtMonto(row.valor_cuota)}).`,
      }));
      return;
    }
    setRowSaving(row.llave);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    try {
      const res  = await fetch("/api/cartera-preventiva/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llave: row.llave, pago_manual: nuevo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al guardar el abono");
      setRowMessage((prev) => ({
        ...prev,
        [row.llave]: nuevo === null
          ? "Corrección del abono eliminada. Se refleja al terminar el recálculo."
          : "Abono corregido. Se refleja al terminar el recálculo.",
      }));
      // Sin matchingKey: es una llave de CUOTA, no de pago — mandarla como
      // matchingKey haría que cruzar.py buscara un pago inexistente y no
      // recalculara nada.
      fireTrigger(row.llave);
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
      setRowMessage((prev) => ({ ...prev, [row.llave]: nuevoValor ? "Marcada como última cuota. Se refleja al terminar el recálculo." : "Desmarcada. Se refleja al terminar el recálculo." }));
      fireTrigger(row.llave);
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
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Saldo asociado. Se aplica al terminar el recálculo." }));
      fetchSaldosFavor();
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // Regla #3: trae los pagos asociados a esta cuota para poder descartar uno.
  const cargarAsociaciones = async (row: CarteraPreventivaRow) => {
    if (descartarData[row.llave]) return;
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
  };

  const toggleDescartarPanel = async (row: CarteraPreventivaRow) => {
    const willOpen = !descartarOpen[row.llave];
    setDescartarOpen((prev) => ({ ...prev, [row.llave]: willOpen }));
    if (willOpen) await cargarAsociaciones(row);
  };

  // "Descartar y marcar pagada por Cartera": el panel pide la fecha apenas se
  // abre (requisito del usuario) y lista lo que va a soltar. Los dos paneles
  // comparten `descartarData` — es la misma consulta.
  const toggleDescartarCerrarPanel = async (row: CarteraPreventivaRow) => {
    const willOpen = !descartarCerrarOpen[row.llave];
    setDescartarCerrarOpen((prev) => ({ ...prev, [row.llave]: willOpen }));
    if (willOpen && !cierreFecha[row.llave]) {
      setCierreFecha((prev) => ({ ...prev, [row.llave]: new Date().toISOString().slice(0, 10) }));
    }
    if (willOpen) await cargarAsociaciones(row);
  };

  // Suelta TODOS los pagos de la cuota y después la cierra por Cartera, con UN
  // solo reproceso al final.
  //
  // ⚠️ Primero descartar y después cerrar, no al revés: si falla el descarte no
  // se cierra nada, y si falla el cierre la cuota queda pendiente con su plata
  // como saldo a favor — un estado que el área ya sabe manejar. Si un descarte
  // falla a mitad de camino se corta ahí: lo que ya se soltó queda soltado.
  //
  // ⚠️ NO se reutiliza handleDescartarPago: ese dispara `fireTrigger` por su
  // cuenta, así que con N pagos encolaría N reprocesos.
  const handleDescartarYCerrar = async (row: CarteraPreventivaRow) => {
    const asociaciones = descartarData[row.llave] || [];
    if (asociaciones.length === 0) return;
    const fecha = cierreFecha[row.llave] || new Date().toISOString().slice(0, 10);
    setRowSaving(`dycerrar:${row.llave}`);
    setRowError((prev) => ({ ...prev, [row.llave]: "" }));
    setDescartarError((prev) => ({ ...prev, [row.llave]: "" }));
    let sueltos = 0;
    try {
      for (const asociacion of asociaciones) {
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
        sueltos++;
        setDescartarData((prev) => ({ ...prev, [row.llave]: (prev[row.llave] || []).filter((a) => a.id !== asociacion.id) }));
      }

      const valorCuota = parseMonto(cuotaEdits[row.llave] ?? row.valor_cuota);
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
      setRowMessage((prev) => ({
        ...prev,
        [row.llave]: `${sueltos} pago(s) descartado(s) y cierre guardado. Se refleja al terminar el recálculo.`,
      }));
      setDescartarCerrarOpen((prev) => ({ ...prev, [row.llave]: false }));
      fetchSaldosFavor();
      fireTrigger(row.llave);
    } catch (err) {
      setRowError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
      // Si alcanzó a soltar algo, esa plata ya se movió: hay que refrescar el
      // ledger y recalcular igual, aunque el cierre no se haya escrito.
      if (sueltos > 0) {
        fetchSaldosFavor();
        fireTrigger(row.llave);
      }
    } finally {
      setRowSaving(null);
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
      setRowMessage((prev) => ({ ...prev, [row.llave]: "Pago descartado. La cuota vuelve a pendiente al terminar el recálculo." }));
      fetchSaldosFavor();
      fireTrigger(row.llave);
    } catch (err) {
      setDescartarError((prev) => ({ ...prev, [row.llave]: err instanceof Error ? err.message : "Error inesperado" }));
    } finally {
      setRowSaving(null);
    }
  };

  // §1: al escribir el documento se buscan sus inscripciones — las que ya están en
  // cartera (se hereda, caso 1) y las del Excel de inscripciones (caso 2, la
  // inscripción todavía no está en cartera). De paso prellena los descriptivos.
  const buscarInscripciones = async (documento: string) => {
    const doc = documento.trim();
    if (!doc) { setAgregarInscripciones([]); setAgregarEnCartera([]); return; }
    setAgregarBuscando(true);
    setAgregarError("");
    try {
      const res  = await fetch(`/api/cartera-preventiva/cuota?documento=${encodeURIComponent(doc)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al buscar inscripciones");
      setAgregarInscripciones(json.inscripciones || []);
      setAgregarEnCartera(json.en_cartera || []);
      setAgregarForm((prev) => ({
        ...prev,
        inscrip: (json.inscripciones || []).length === 1 ? json.inscripciones[0] : prev.inscrip,
        cliente: prev.cliente || json.prefill?.cliente || "",
        programa: prev.programa || json.prefill?.programa || "",
        correo: prev.correo || json.prefill?.correo || "",
        moneda: json.prefill?.moneda || prev.moneda,
        sistema_financiero: json.prefill?.sistema_financiero || prev.sistema_financiero,
      }));
    } catch (err) {
      setAgregarError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setAgregarBuscando(false);
    }
  };

  const handleAgregarCuota = async () => {
    setAgregarGuardando(true);
    setAgregarError("");
    try {
      const res  = await fetch("/api/cartera-preventiva/cuota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...agregarForm, valor_cuota: parseMonto(agregarForm.valor_cuota) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al crear la cuota");
      setAgregarMessage(`Cuota ${json.llave} creada. Reprocesando el cruce…`);
      setAgregarOpen(false);
      setAgregarForm({
        cruce_access: "", inscrip: "", fecha_vencimiento: "", valor_cuota: "",
        cliente: "", programa: "", correo: "", moneda: "COP", sistema_financiero: "SIST_F_NUEVO",
      });
      setAgregarInscripciones([]);
      setAgregarEnCartera([]);
      fetchData(page);
      fireTrigger();
    } catch (err) {
      setAgregarError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setAgregarGuardando(false);
    }
  };

  // Qué día alcanza "Cerrar Cartera": el filtro "Día del Cruce" de la vista si está
  // puesto, y si no, hoy — el mismo criterio que aplica el endpoint. El aviso tiene que
  // nombrarlo: desde que el botón respeta el filtro puede alcanzar cualquier rango, y
  // no se puede deshacer desde la UI.
  const cierreDiaLabel =
    cruceFrom && cruceTo
      ? (cruceFrom === cruceTo ? `el ${cruceFrom}` : `entre el ${cruceFrom} y el ${cruceTo}`)
      : cruceFrom
      ? `desde el ${cruceFrom}`
      : cruceTo
      ? `hasta el ${cruceTo}`
      : "hoy";

  // §2.2: cierra en bloque las cuotas cruzadas en el día alcanzado que coincidan con
  // los filtros de la vista. No dispara reproceso: la escritura es inmediata y el
  // pipeline la respeta (su chequeo de idempotencia compara valor_pago contra la suma
  // de asociaciones, que no cambia al cerrar).
  const handleCerrarDia = async () => {
    setCerrandoDia(true);
    setCerrarDiaError("");
    setCerrarDiaMessage("");
    try {
      const res  = await fetch("/api/cartera-preventiva/cerrar-dia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(buildDownloadParams()),
          dia: new Date().toLocaleDateString("en-CA"), // YYYY-MM-DD en la zona del usuario
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al cerrar la cartera del día");
      const partes = [`Se cerraron ${json.cerradas} cuota(s) cruzada(s) ${cierreDiaLabel}.`];
      if (json.saltadas > 0) partes.push(`${json.saltadas} ya estaban cerradas o sin pago identificado.`);
      if (json.errores?.length) partes.push(`Con errores: ${json.errores.join(" · ")}`);
      setCerrarDiaMessage(partes.join(" "));
      setCerrarDiaOpen(false);
      fetchData(page);
    } catch (err) {
      setCerrarDiaError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setCerrandoDia(false);
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
      setActivarMessage("Cambiando la versión de la cartera...");
      // §3: esperar a que el swap termine de verdad antes de recargar. Sin esto el
      // banner se quedaba pegado en "Actualizando la vista…" con datos de la versión
      // anterior. El tope duro evita dejarlo colgado si el VPS deja de responder.
      const inicio = Date.now();
      let vistoCorriendo = false;
      while (Date.now() - inicio < ACTIVAR_MAX_MS) {
        await new Promise((r) => setTimeout(r, ACTIVAR_POLL_MS));
        const st = await fetch("/api/cartera-preventiva/activar/status").then((r) => r.json()).catch(() => null);
        if (!st) break;
        if (st.status === "running") { vistoCorriendo = true; continue; }
        if (vistoCorriendo || Date.now() - inicio > ACTIVAR_GRACE_MS) break;
      }
      setActivarMessage("Cartera nueva activada.");
      await fetchStagingStatus();
      setPage(1);
      fetchData(1);
      // El cruce hay que rehacerlo sobre la cartera nueva: era uno de los 3 huecos (§3).
      fireTrigger();
    } catch (err) {
      setActivarError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setActivando(false);
    }
  };

  // ── Lo que se deriva de una fila ──────────────────────────────────────────
  // Vive en UNA función porque desde el 2026-10-02 lo preguntan DOS sitios: la
  // fila de la tabla y el cajón lateral. Copiarlo en los dos es desincronizarlos,
  // que es el fallo de siempre en esta app (regla 3.7): el cajón ofrecería
  // asociar en una cuota que la tabla ya da por cerrada, o al revés.
  //
  // ⚠️ Lo que NO entra acá es lo que depende de las casillas editables de la fila
  // (`cuotaEdits`, `vencEdits`, `pagoEdits`): esas columnas se editan en la tabla
  // y solo ahí.
  const derivarFila = (row: CarteraPreventivaRow) => {
    const parcial = isPagoParcial(row);
    const saldoFavor = isSaldoFavor(row);
    const pendiente = !row.fecha_pago;
    // La cuota que quedó corta y tiene plata esperando (2026-08-21). NO es
    // `pendiente` —recibió el primer pago—, así que sin esto el panel de asociar
    // no se ofrecería justo en la fila que lo necesita.
    const avisoSinAplicar = esPagoSinAplicar(row.notificacion);
    // Cerrada = alguien la cerró y `pago` ya refleja el valor_pago (si el pago
    // cambió después, vuelve a ofrecerse el cierre).
    const cerrada = row.pago_confirmado != null && row.pago_confirmado === row.valor_pago;
    // El Excel ya trae el pago en `pago` (mismo número, o centavos de
    // diferencia): la cuota ya está cobrada en el Sistema Financiero, así que no
    // hay nada que cerrar — y cerrarla duplicaría el pago, porque la fórmula
    // acumula. Ojo: `pago` es text en la base y puede traer decimales
    // ("485086.5"), así que va parseFloat — NO parseMonto, que está hecho para la
    // entrada del usuario ("." = miles).
    const yaCobrada = !cerrada && row.valor_pago != null
      && Math.abs(numPago(row.pago) - row.valor_pago) <= 100;
    // El documento tiene plata que el panel puede ofrecer: algún pago con
    // restante, contado igual que lo cuenta GET /asociar. Desde el 2026-10-02 ya
    // NO exige 2+ inscripciones (§6 del spec, decisión del usuario): con el panel
    // por cuota la pregunta es "a esta cuota, ¿qué plata le entra?", y vale con
    // una sola inscripción.
    const hayPagoDelDoc = multiInscripcionDocs.has(row.cruce_access);
    // Regla #4/#7: documento es la señal FUERTE, correo la débil. Unión de las
    // dos, sin repetir un saldo que caiga por ambas.
    const porDoc    = saldosPorDocumento.get((row.cruce_access || "").trim()) || [];
    const porCorreo = saldosPorCorreo.get((row.correo || "").trim().toLowerCase()) || [];
    const saldosDeLaFila = Array.from(
      new Map([...porDoc, ...porCorreo].map((s) => [s.id, s])).values()
    );
    const grupo = saldosDeLaFila.length
      ? { total: saldosDeLaFila.reduce((a, s) => a + Number(s.disponible), 0), rows: saldosDeLaFila }
      : undefined;
    const tieneSaldo = !!grupo && grupo.total > 0;
    // 🔴 Una cuota declarada "pagada por Cartera" no recibe plata (spec del
    // 2026-10-02). Las dos mitades de la señal:
    //   · ya aplicada por el pipeline → se ve en la fila;
    //   · recién cerrada, con el reproceso corriendo → la fila no dice NADA (el
    //     cierre vive en un override), y entonces la única señal que hay en la
    //     pantalla es que GET /asociar la dejó fuera de `inscripciones`, que es
    //     justo lo que ese endpoint decide con `fetchCerradasManual`. Se le cree a
    //     él en vez de volver a preguntar los overrides desde acá.
    // ⚠️ La ausencia solo significa "cerrada" para una cuota que el endpoint SÍ
    // habría listado: una cuota ya cubierta no está en esa lista y está
    // perfectamente bien (regla del 14/09).
    const datosDelDoc  = asociarData[row.cruce_access];
    const deberiaEstar = pendiente || avisoSinAplicar;
    const cerradaPorCartera =
      row.notificacion === "CARTERA" || row.medio_pago === "Cartera" ||
      (deberiaEstar && !!datosDelDoc
        && !datosDelDoc.inscripciones.some((i) => i.llave === row.llave));
    // 🔴 Lo único que nunca recibe plata, además, es una línea de deuda cuya cuota
    // original siga abierta: ahí la plata va en la original, si no se pagaría la
    // misma deuda dos veces (regla del 30 de julio).
    const puedeRecibirPlata = !row.original_abierta && !cerradaPorCartera;
    // Una cuota YA CUBIERTA también puede recibir plata, y por eso acá no se
    // pregunta si la cuota necesita dinero (hasta el 14/09 había un
    // `necesitaDinero` en esta condición). Si la persona pagó de más, la fila
    // TIENE que decirlo: con la plata asociada el pipeline escribe "PAGA N
    // CUOTAS" / "N CUOTAS + ABONO", que son las etiquetas con las que el área lee
    // la cartera (caso doc 79670680).
    const puedeAsociarSaldo = tieneSaldo && puedeRecibirPlata;
    // ⚠️ `ofrecePagos` (se ve la sección) y `puedeAsociarPago` (se pueden apretar
    // los botones) son distintos a propósito: en una cuota que no puede recibir
    // plata, la sección se sigue viendo para dejar MANDAR ese pago a otro
    // documento —que es el único camino que había y no se quita—, con el motivo
    // escrito arriba.
    const ofrecePagos      = hayPagoDelDoc && deberiaEstar;
    const puedeAsociarPago = ofrecePagos && puedeRecibirPlata;
    const cuotaRestante = pendiente ? row.valor_a_cobrar : Math.abs(row.diferencia ?? 0);
    // Regla #3: descartar solo tiene sentido sobre un pago real ya aplicado — un
    // cierre manual de cartera no tiene pago asociado que descartar.
    const puedeDescartar = !pendiente && row.medio_pago !== "Cartera" && row.notificacion !== "CARTERA";
    // La excepción, y la única: una cuota cerrada por Cartera QUE TENGA un pago
    // encima. Eso no debería existir —desde el 2/10 las cuatro puertas de
    // asociación la rechazan— pero el caso de ese día (doc 1099208759: cerrada por
    // Cartera y comiéndose $1.040.000, con 29 segundos entre los dos clics) solo
    // se pudo deshacer por SQL.
    // 🔴 `puedeDescartar` NO se toca: sigue dejando fuera las cerradas por
    // Cartera, que es lo correcto — un cierre por Cartera normal no tiene pago que
    // soltar. Hoy esta condición alcanza 0 filas.
    const puedeDescartarCerradaPorCartera =
      (row.medio_pago === "Cartera" || row.notificacion === "CARTERA") &&
      row.tiene_asociaciones === true;
    // Hay DOS tipos de cierre y no se deshacen igual. Para el área es la misma
    // acción —una sola etiqueta "Reabrir"—; la diferencia es interna: el cierre
    // por Cartera vive en un override (lo apaga el pipeline en su próxima corrida,
    // y queda sin Día del Cruce a propósito: esas cuotas no tienen pago real que
    // cruzar), mientras el cierre con pago asignado se deshace escribiendo la fila
    // con la inversa de su fórmula.
    const cierrePorCartera = !pendiente && row.notificacion === "CARTERA";
    const cierreConPago    = cerrada && row.notificacion !== "CARTERA";
    return {
      parcial, saldoFavor, pendiente, avisoSinAplicar, cerrada, yaCobrada,
      grupo, tieneSaldo, cerradaPorCartera, puedeRecibirPlata,
      puedeAsociarSaldo, ofrecePagos, puedeAsociarPago, cuotaRestante,
      puedeDescartar, puedeDescartarCerradaPorCartera, cierrePorCartera, cierreConPago,
    };
  };
  type FilaDerivada = ReturnType<typeof derivarFila>;

  // Las acciones que ofrece una cuota, en el orden fijo del spec del 31/08.
  // 🔴 "Asociar" NO está acá: desde el cajón dejó de ser una acción que se elige y
  // pasó a ser la sección principal, siempre a la vista cuando aplica. Las que
  // quedan abren su formulario dentro del mismo cajón.
  // 🔴 Las SEÑALES tampoco entran ("Cuota cerrada", "Ya cobrada", el saldo a favor,
  // el badge del reproceso y los mensajes): no son acciones, son lo que le dice al
  // área que en esa fila hay trabajo, y se quedan en la celda — detrás de un clic
  // nadie las ve pasando la tabla.
  const accionesDe = (row: CarteraPreventivaRow, d: FilaDerivada) => {
    const acciones: { key: string; label: string; onClick: () => void; className: string; title?: string }[] = [];
    if (d.pendiente && row.valor_pago == null) acciones.push({
      key: "cierre",
      label: cierreOpen[row.llave] ? "Ocultar cierre" : "Marcar pagada por Cartera",
      onClick: () => toggleCierrePanel(row),
      className: "text-gray-700",
      title: "La cuota no tiene pago identificado — declararla pagada por cartera",
    });
    if (d.puedeDescartar || d.puedeDescartarCerradaPorCartera) acciones.push({
      key: "descartar",
      label: descartarOpen[row.llave] ? "Ocultar descartar" : "Descartar pago",
      onClick: () => toggleDescartarPanel(row),
      className: "text-red-700",
      title: d.puedeDescartarCerradaPorCartera
        ? "Esta cuota está cerrada por Cartera y además tiene un pago aplicado: suéltalo acá; vuelve como saldo a favor del documento"
        : "Suelta un pago de esta cuota; vuelve como saldo a favor del documento",
    });
    // Va DEBAJO de "Descartar pago" y no lo reemplaza: a veces solo hay que
    // descartar, y un botón que además cierre sería un problema (decisión
    // explícita del usuario).
    if (d.puedeDescartar && !d.cerrada && !d.yaCobrada) acciones.push({
      key: "descartar-cerrar",
      label: descartarCerrarOpen[row.llave] ? "Ocultar descartar y cerrar" : "Descartar y marcar pagada por Cartera",
      onClick: () => toggleDescartarCerrarPanel(row),
      className: "text-slate-700",
      title: "Suelta los pagos de la cuota y la cierra por Cartera, de un paso",
    });
    if (necesitaUltimaCuota(row)) acciones.push({
      key: "ultima",
      label: ultimaCuotaLlaves.has(row.llave) ? "✓ Última cuota" : "Es la última cuota",
      onClick: () => handleToggleUltimaCuota(row),
      className: "text-indigo-700",
      title: "Marca que esta es la última cuota de la inscripción (modo B): un sobrante pasa a excedente final, un faltante se condona hasta $50k",
    });
    if (d.cierrePorCartera || d.cierreConPago) acciones.push({
      key: "reabrir",
      label: "Reabrir",
      onClick: () => d.cierrePorCartera ? handleReabrirCartera(row) : handleReabrirCuota(row),
      className: "text-slate-700",
      title: d.cierrePorCartera
        ? "Deshace el cierre manual — la cuota vuelve a pendiente en el próximo cruce"
        : "Deshace el cierre y pone el Día del Cruce de hoy. No cambia el pago ni los datos de la cuota.",
    });
    return acciones;
  };

  // La cuota abierta en el cajón, leída de `data` para que se actualice sola con
  // cada recarga. Si dejó de estar en pantalla, `fetchData` ya cerró el cajón.
  const filaCajon = cajonLlave ? data.find((r) => r.llave === cajonLlave) ?? null : null;

  // 🔴 La cuota que se PINTA no es la misma que decide si el cajón está abierto.
  // Al cerrarlo, el ancho tarda 300 ms en llegar a cero; si el contenido se
  // desmontara en el primer fotograma, se vería una franja blanca encogiéndose en
  // vez del cajón yéndose. Así que se sigue pintando la última cuota mientras dura
  // la animación. La escritura en el ref es el patrón de "último valor": no cambia
  // nada del render, solo lo recuerda.
  const ultimaLlaveRef = useRef<string | null>(null);
  if (cajonLlave !== null) ultimaLlaveRef.current = cajonLlave;
  const llavePintada = cajonLlave ?? ultimaLlaveRef.current;
  const filaPintada  = llavePintada ? data.find((r) => r.llave === llavePintada) ?? null : null;

  // Abre el cajón en una cuota —o lo cierra si ya estaba en esa— y, de paso, pide
  // los pagos del documento. 🔴 La carga va acá y no en un efecto: apretar es lo
  // que la dispara, y un efecto obligaría a la IIFE async de siempre
  // (`react-hooks/set-state-in-effect`) para hacer exactamente lo mismo.
  // ⚠️ Apretar el botón de OTRA fila con el cajón abierto lo cambia de cuota sin
  // cerrarlo: es lo que hace que comparar dos cuotas de la misma persona sea un
  // clic, que es el trabajo del día.
  const abrirCajon = async (row: CarteraPreventivaRow) => {
    const yaEstaba = cajonLlave === row.llave;
    setCajonLlave(yaEstaba ? null : row.llave);
    if (yaEstaba) return;
    const doc = row.cruce_access;
    if (doc && !asociarData[doc]) await fetchAsociarData(doc);
  };

  return (
    // 🔴 El cajón es una COLUMNA de este flex, igual que la barra lateral del
    // shell (`shrink-0 sticky top-0 h-screen`): EMPUJA la tabla en vez de taparla.
    // El borde derecho es justo donde vive la columna Acciones, así que un panel
    // encima cubriría el botón de todas las demás filas y no se podría cambiar de
    // cuota sin cerrarlo — que es lo que este cajón existe para permitir.
    <div className="flex min-h-screen">
      <div className="flex-1 min-w-0 p-5 pb-8 space-y-4">
        {reprocesoBadge}
        <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
          <h1 className="text-lg font-semibold text-gray-900">Cartera Preventiva</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <BuscarArchivosButton onDone={async () => { await fetchData(page); return fetchStagingStatus(); }} />
            <button
              onClick={() => setAgregarOpen(true)}
              className="flex items-center gap-1.5 border border-black/10 text-brand-700 text-sm px-3.5 py-1.5 rounded-full hover:bg-brand-50 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Agregar cuota
            </button>
            <button
              onClick={() => { setCerrarDiaOpen(true); setCerrarDiaMessage(""); setCerrarDiaError(""); }}
              disabled={cerrandoDia}
              title={`Pasa valor_pago a pago en las cuotas cruzadas ${cierreDiaLabel} que coincidan con los filtros de la vista`}
              className="flex items-center gap-1.5 bg-slate-700 text-white text-sm px-3.5 py-1.5 rounded-full shadow-sm hover:bg-slate-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {cerrandoDia ? "Cerrando..." : "Cerrar Cartera"}
            </button>
          </div>
        </div>

        {(cerrarDiaMessage || cerrarDiaError) && (
          <div className={`text-sm rounded-xl px-3.5 py-2 border ${cerrarDiaError ? "text-red-600 bg-red-50 border-red-200/80" : "text-green-700 bg-green-50 border-green-200/80"}`}>
            {cerrarDiaError || cerrarDiaMessage}
          </div>
        )}

        {/* §2.2: confirmación obligatoria, sin deshacer. */}
        {cerrarDiaOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={() => !cerrandoDia && setCerrarDiaOpen(false)}>
            <div className={`${PANEL} animate-pop-in max-w-md w-full p-6 space-y-3`} onClick={(e) => e.stopPropagation()}>
              <h2 className="text-base font-semibold text-gray-900">
                ¿Estás seguro de cerrar la cartera cruzada {cierreDiaLabel}?
              </h2>
              <p className="text-sm text-gray-600">
                Se marcarán como cobradas las cuotas cruzadas <span className="font-medium">{cierreDiaLabel}</span> que
                coincidan con los filtros puestos en la vista (<span className="font-medium">{total.toLocaleString("es-CO")}</span> en
                pantalla): el valor identificado pasa a la columna <span className="font-medium">Pago</span> y
                lo que falte queda a la vista en <span className="font-medium">Valor a Cobrar</span>.
              </p>
              <p className="text-xs text-gray-500">
                No se puede deshacer desde esta pantalla. Las cuotas ya cerradas y las que no tienen
                pago identificado se saltan solas —así que el número final puede ser menor, y darle
                dos veces no hace daño.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setCerrarDiaOpen(false)}
                  disabled={cerrandoDia}
                  className="text-sm px-3.5 py-1.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleCerrarDia}
                  disabled={cerrandoDia}
                  className="text-sm px-3.5 py-1.5 rounded-full bg-slate-700 text-white hover:bg-slate-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                >
                  {cerrandoDia ? "Cerrando..." : "Confirmar"}
                </button>
              </div>
            </div>
          </div>
        )}

        {agregarMessage && (
          <div className="text-sm text-green-700 bg-green-50 border border-green-200/80 rounded-xl px-3.5 py-2">
            {agregarMessage}
          </div>
        )}

        {/* §1: crear a mano una cuota que no vino en el Excel. */}
        {agregarOpen && (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 py-10 overflow-y-auto" onClick={() => !agregarGuardando && setAgregarOpen(false)}>
            <div className={`${PANEL} animate-pop-in max-w-lg w-full p-6 space-y-3`} onClick={(e) => e.stopPropagation()}>
              <h2 className="text-base font-semibold text-gray-900">Agregar cuota</h2>
              <p className="text-xs text-gray-500">
                Para cuotas que deberían estar en la cartera y no vinieron en el Excel. El pago de esa
                persona no se pierde: en cuanto exista la cuota, el reproceso lo aplica en cuanto termina.
              </p>

              <div className="space-y-2.5">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Documento *</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={agregarForm.cruce_access}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, cruce_access: e.target.value }))}
                      onBlur={(e) => buscarInscripciones(e.target.value)}
                      placeholder="Documento del deudor"
                      className={`flex-1 ${INPUT}`}
                    />
                    <button
                      onClick={() => buscarInscripciones(agregarForm.cruce_access)}
                      disabled={agregarBuscando || !agregarForm.cruce_access.trim()}
                      className="text-sm px-3 py-1.5 rounded-xl border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 whitespace-nowrap"
                    >
                      {agregarBuscando ? "Buscando..." : "Buscar"}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Inscripción (INCP) *</label>
                  {agregarInscripciones.length > 0 ? (
                    <select
                      value={agregarForm.inscrip}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, inscrip: e.target.value }))}
                      className={`w-full ${INPUT}`}
                    >
                      <option value="" className="text-gray-900">Elige una inscripción...</option>
                      {agregarInscripciones.map((i) => (
                        <option key={i} value={i} className="text-gray-900">
                          {i}{agregarEnCartera.includes(i) ? " — ya está en cartera" : " — solo en el Excel de inscripciones"}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={agregarForm.inscrip}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, inscrip: e.target.value }))}
                      placeholder="Busca el documento para elegir, o escríbela"
                      className={`w-full ${INPUT}`}
                    />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Fecha de vencimiento *</label>
                    <input
                      type="date"
                      value={agregarForm.fecha_vencimiento}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, fecha_vencimiento: e.target.value }))}
                      className={`w-full ${INPUT}`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Valor de la cuota *</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={agregarForm.valor_cuota}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, valor_cuota: e.target.value }))}
                      onBlur={(e) => setAgregarForm((p) => ({ ...p, valor_cuota: formatMonto(e.target.value) }))}
                      className={`w-full ${INPUT}`}
                    />
                  </div>
                </div>

                {agregarForm.fecha_vencimiento && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200/80 rounded-lg px-2 py-1.5">
                    La fecha de vencimiento define el orden de cobro: una fecha vieja hace que esta
                    cuota se cobre <span className="font-medium">antes</span> que las que ya estaban pendientes.
                  </p>
                )}

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Cliente</label>
                    <input type="text" value={agregarForm.cliente}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, cliente: e.target.value }))}
                      className={`w-full ${INPUT}`} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Programa</label>
                    <input type="text" value={agregarForm.programa}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, programa: e.target.value }))}
                      className={`w-full ${INPUT}`} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Correo</label>
                    <input type="text" value={agregarForm.correo}
                      onChange={(e) => setAgregarForm((p) => ({ ...p, correo: e.target.value }))}
                      className={`w-full ${INPUT}`} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Moneda</label>
                      <input type="text" value={agregarForm.moneda}
                        onChange={(e) => setAgregarForm((p) => ({ ...p, moneda: e.target.value }))}
                        className={`w-full ${INPUT}`} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Sist. Fin.</label>
                      <input type="text" value={agregarForm.sistema_financiero}
                        onChange={(e) => setAgregarForm((p) => ({ ...p, sistema_financiero: e.target.value }))}
                        className={`w-full ${INPUT}`} />
                    </div>
                  </div>
                </div>

                {agregarInscripciones.length > 1 && (
                  <p className="text-[11px] text-gray-500">
                    Ojo: si esta persona queda con dos inscripciones debiendo, el sistema deja de
                    aplicarle los pagos automáticamente y pasan a asociación manual. Es a propósito,
                    para que la plata no caiga en la inscripción equivocada.
                  </p>
                )}
                <p className="text-[11px] text-gray-400">
                  Al hacer &quot;Cargar Cartera&quot; esta cuota no se recrea: se archiva con la versión, como
                  cualquier otra. Si sigue faltando, se vuelve a crear.
                </p>
              </div>

              {agregarError && <p className="text-xs text-red-600">{agregarError}</p>}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setAgregarOpen(false)}
                  disabled={agregarGuardando}
                  className="text-sm px-3.5 py-1.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-100 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleAgregarCuota}
                  disabled={
                    agregarGuardando ||
                    !agregarForm.cruce_access.trim() ||
                    !agregarForm.inscrip.trim() ||
                    !agregarForm.fecha_vencimiento ||
                    !(parseMonto(agregarForm.valor_cuota) > 0)
                  }
                  className="text-sm px-3.5 py-1.5 rounded-full bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                >
                  {agregarGuardando ? "Creando..." : "Crear cuota"}
                </button>
              </div>
            </div>
          </div>
        )}

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
                placeholder="Buscar por documento, cliente, INCP o VAL..."
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
              <option value="cerrada" className="text-gray-900">Cerradas</option>
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
            {/* Diferencia: el umbral de "le falta plata" depende de la moneda de la
                cuota (ver lib/carteraDiferencia.ts). Cada cuota que califica baja con
                sus líneas derivadas pegadas debajo, aunque esas no califiquen solas. */}
            <select
              value={diferencia}
              onChange={(e) => { setDiferencia(e.target.value); setPage(1); }}
              className={INPUT}
              title="Le falta plata: deuda de $50.000 o más (15 USD o más en cuotas en dólares). Le sobra plata: diferencia de $1 en adelante."
            >
              <option value="" className="text-gray-900">Cualquier diferencia</option>
              <option value="falta" className="text-gray-900">Le falta plata</option>
              <option value="sobra" className="text-gray-900">Le sobra plata</option>
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
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={multiCuota}
                onChange={(e) => { setMultiCuota(e.target.checked); setPage(1); }}
                className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
              />
              <span className="font-medium">Inscripciones con varias cuotas</span>
            </label>
            {/* El pipeline avisa en `notificacion` cuando dejó una cuota corta por menos
                del umbral y por eso NO aplicó solo el pago siguiente. Es trabajo del día:
                nadie las encuentra buscando por documento, porque quien revisa no sabe
                que existen. Va aparte del desplegable de estado a propósito — esas 3
                opciones parten la cartera sin solapes. */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={pagoSinAplicar}
                onChange={(e) => { setPagoSinAplicar(e.target.checked); setPage(1); }}
                className="rounded border-gray-300 text-brand-600 focus:ring-brand-500/50"
              />
              <span className="font-medium">Con pago sin aplicar</span>
            </label>
            {(search || estado !== "todas" || vencFrom || vencTo || pagoParcial || medioPago || payFrom || payTo || cruceFrom || cruceTo || conNotificacion || multiCuota || pagoSinAplicar || diferencia || wompiTipo) && (
              <button
                onClick={() => { setSearch(""); setEstado("todas"); setVencFrom(""); setVencTo(""); setPagoParcial(false); setMedioPago(""); setPayFrom(""); setPayTo(""); setCruceFrom(""); setCruceTo(""); setConNotificacion(false); setMultiCuota(false); setPagoSinAplicar(false); setDiferencia(""); setWompiTipo(""); setPage(1); }}
                className="text-red-500 hover:text-red-700 text-xs underline"
              >
                Limpiar filtros
              </button>
            )}
          </div>
        </div>

        <div className="px-1 flex items-center justify-between gap-3">
          <span className="text-sm text-gray-500">
            {loading
              ? "Cargando..."
              : diferencia && renglones !== null
                // Con el filtro puesto se pagina por CUOTA, no por renglón: una cuota
                // arrastra sus líneas derivadas, así que los dos números no coinciden.
                ? `${total.toLocaleString("es-CO")} cuotas (${renglones.toLocaleString("es-CO")} renglones)`
                : `${total.toLocaleString("es-CO")} registros encontrados`}
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
                    const d = derivarFila(row);
                    const { parcial, saldoFavor, cerrada, yaCobrada, tieneSaldo, grupo } = d;
                    const saving = rowSaving === row.llave;
                    const cuotaValue = cuotaEdits[row.llave] ?? formatMonto(row.valor_cuota);
                    const cuotaChanged = cuotaValue.trim() !== "" && parseMonto(cuotaValue) !== row.valor_cuota && !Number.isNaN(parseMonto(cuotaValue));
                    // <input type="date"> entrega YYYY-MM-DD, el mismo formato que
                    // guarda la columna `date` — no pasar por Date(), que interpreta
                    // ese string en UTC y en Colombia devuelve el día anterior.
                    const vencValue   = vencEdits[row.llave] ?? row.fecha_vencimiento ?? "";
                    const vencChanged = vencValue.trim() !== "" && vencValue !== row.fecha_vencimiento;
                    // Abono del Excel, editable. `pago` es text y puede traer centavos
                    // ("485086.5"): se muestra redondeado a pesos como el resto de la
                    // vista, y la comparación "cambió / no cambió" va contra ese mismo
                    // entero — si no, toda cuota con decimales saldría con el ✓ puesto
                    // de entrada. Vaciar la casilla borra la corrección
                    // (pago_manual = null), y por eso cuenta como cambio solo si la
                    // fila hoy trae abono.
                    const pagoActual  = Math.round(numPago(row.pago));
                    const pagoGuardado = row.pago != null && row.pago.trim() !== "";
                    const pagoValue   = pagoEdits[row.llave] ?? (pagoGuardado ? formatMonto(pagoActual) : "");
                    const pagoNum     = parseMonto(pagoValue);
                    const pagoChanged = pagoValue.trim() === ""
                      ? pagoGuardado
                      : Number.isFinite(pagoNum) && pagoNum !== pagoActual;
                    const abierta = cajonLlave === row.llave;
                    return (
                    <Fragment key={row.id}>
                    <tr className={`hover:bg-gray-50/70 transition-colors duration-100 align-top ${rowTint(row)}`}>
                      <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.llave)}</td>
                      <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.sistema_financiero)}</td>
                      <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                        {fmt(row.inscrip)}
                        {(row.cuotas_inscripcion ?? 1) > 1 && (
                          <span className="ml-1.5 text-[11px] text-gray-500">{row.cuotas_inscripcion} cuotas</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.cliente)}</td>
                      <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmt(row.moneda)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="date"
                            value={vencValue}
                            onChange={(e) => setVencEdits((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                            disabled={saving}
                            className="w-36 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                          />
                          {vencChanged && (
                            <button
                              onClick={() => handleSaveFechaVencimiento(row)}
                              disabled={saving}
                              title="Guardar corrección de fecha de vencimiento"
                              className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              ✓
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={cuotaValue}
                            onChange={(e) => setCuotaEdits((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                            onBlur={(e) => setCuotaEdits((prev) => ({ ...prev, [row.llave]: formatMonto(e.target.value) }))}
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
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={pagoValue}
                            title="Abono que trae el Excel de cartera. 0 = ese abono no existe; vacío borra la corrección."
                            onChange={(e) => setPagoEdits((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                            onBlur={(e) => setPagoEdits((prev) => ({ ...prev, [row.llave]: formatMonto(e.target.value) }))}
                            disabled={saving}
                            className="w-24 border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors disabled:bg-gray-100"
                          />
                          {pagoChanged && (
                            <button
                              onClick={() => handleSavePago(row, pagoValue)}
                              disabled={saving}
                              title="Guardar corrección del abono"
                              className="text-xs px-1.5 py-1 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              ✓
                            </button>
                          )}
                        </div>
                      </td>
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
                        <div className="flex flex-col gap-1 min-w-[150px]">
                          {/* Un botón, y siempre: abre el cajón lateral con la ficha de
                              la cuota y todo lo que se le puede hacer. Antes esto era un
                              menú desplegable que abría cinco formularios en una fila
                              expandida debajo — y esa fila se dibujaba pegada al borde
                              IZQUIERDO de la tabla mientras el botón vive en la última
                              columna, o sea a miles de píxeles de donde estaba mirando
                              quien lo apretó.
                              🔴 Va habilitado aunque la cuota no ofrezca ninguna acción:
                              el cajón también sirve para LEERLA. Son 21 columnas, y la
                              ficha es la única forma de ver una cuota entera sin
                              desplazar la tabla de lado a lado. */}
                          <button
                            onClick={() => abrirCajon(row)}
                            className={`w-full text-xs px-2 py-1 rounded-lg border active:scale-95 transition-all duration-200 ease-(--ease-spring) flex items-center justify-between gap-1 ${
                              abierta
                                ? "border-brand-600 bg-brand-50 text-brand-700"
                                : "border-gray-300 text-gray-700 hover:bg-gray-100"
                            }`}
                          >
                            <span>{abierta ? "Abierta" : "Abrir"}</span>
                            <span className="text-[10px] text-gray-400">{abierta ? "✕" : "›"}</span>
                          </button>
                          {/* Las SEÑALES se quedan acá, no se van al cajón (§6.2): son lo
                              que le dice al área que en esta fila hay trabajo, y detrás
                              de un clic nadie las ve pasando la tabla. */}
                          {cerrada && (
                            <span className="text-[11px] text-gray-400 whitespace-nowrap">Cuota cerrada</span>
                          )}
                          {yaCobrada && (
                            <span
                              title="El Sistema Financiero ya la registra cobrada (Pago = Valor pagado) — no hay nada que cerrar"
                              className="text-[11px] text-gray-400 whitespace-nowrap"
                            >
                              Ya cobrada
                            </span>
                          )}
                          {tieneSaldo && (
                            <span className="text-[11px] text-teal-800">
                              Saldo a favor de {fmtMonto(grupo!.total)}
                            </span>
                          )}
                          {marcaFila(row.llave)}
                          {rowMessage[row.llave] && <span className="text-[11px] text-green-700">{rowMessage[row.llave]}</span>}
                          {rowError[row.llave] && <span className="text-[11px] text-red-600">{rowError[row.llave]}</span>}
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

      {/* ══════════════════════════════════════════════════════════════════════
          EL CAJÓN LATERAL (2026-10-02). Reemplaza al menú desplegable de la
          columna Acciones y a la fila expandida que se abría debajo.

          Lo que arregla: esa fila se dibujaba con `sticky left-0`, o sea pegada
          al borde IZQUIERDO de la tabla, mientras el botón que la abría vive en
          la ÚLTIMA de 21 columnas. Con la tabla desplazada a la derecha —que es
          como se trabaja— el panel aparecía a miles de píxeles de donde estaba
          el dedo, y se leía como que el botón no hacía nada.

          🔴 NO lleva fondo oscurecido y NO bloquea la tabla (decisión del
          usuario): se puede seguir leyendo, desplazando y apretando el botón de
          otra fila, y el cajón cambia de cuota sin cerrarse.

          🔴 NO es `fixed` ni va por portal (2026-10-02, pedido del usuario con la
          pantalla a la vista): es una COLUMNA de este flex, construida igual que la
          barra lateral del shell — `shrink-0 sticky top-0 h-screen`, el ancho
          animado de `w-0` a `w-[26rem]` con `overflow-hidden`. Así el ancho de la
          tabla es ancho de verdad y no un padding por debajo de un panel flotante:
          la barra de scroll horizontal, el `sticky` del encabezado y el ancho
          visible de las 21 columnas se recalculan solos.
          ⚠️ Y de paso desaparece la trampa del `position: fixed` en esta app:
          `DashboardShell` envuelve cada página en un `<div className="animate-fade-in">`
          cuya animación termina con `fill-mode: both`, dejando puesto un
          `transform: translateY(0)` — y un transform distinto de `none` crea bloque
          contenedor para los `fixed` de adentro (medido en Chromium: un hijo
          `fixed inset-y-0` salía de 3.000 px en vez de los 713 de la ventana). Sin
          `fixed` no hay nada que anclar.
          🔴 El contenido va en un `div` de ANCHO FIJO (`w-[26rem]`) adentro: si
          heredara el ancho que se está animando, los 12 campos de la ficha se
          re-maquetarían 60 veces por segundo mientras el cajón entra.
          ══════════════════════════════════════════════════════════════════════ */}
      <aside
        role="complementary"
        aria-label={filaCajon ? `Cuota ${filaCajon.llave}` : undefined}
        // Con el cajón cerrado el contenido sigue montado (ver el ref de arriba)
        // pero recortado a 0 px: `inert` lo saca del tabulador y del lector de
        // pantalla, que si no llegarían a botones que nadie puede ver.
        inert={!filaCajon}
        className={`shrink-0 sticky top-0 h-screen bg-white overflow-hidden transition-all duration-300 ease-in-out ${
          filaCajon
            ? "w-[26rem] border-l border-black/[0.08] shadow-[-18px_0_40px_-20px_rgba(16,24,40,0.45)]"
            : "w-0 border-l-0"
        }`}
      >
        <div className="w-[26rem] h-screen flex flex-col">
        {filaPintada && (() => {
        const row = filaPintada;
        const d   = derivarFila(row);
        const { cerrada, yaCobrada, tieneSaldo, grupo, cuotaRestante,
                ofrecePagos, puedeAsociarPago, puedeAsociarSaldo, cerradaPorCartera,
                parcial, saldoFavor, pendiente, avisoSinAplicar } = d;
        const saving    = rowSaving === row.llave;
        const savingDyC = rowSaving === `dycerrar:${row.llave}`;
        const asociacionesDeLaCuota = descartarData[row.llave] || [];
        const acciones  = accionesDe(row, d);
        // La ficha, ya sin lo que subió al titular y a la tira (diferencia,
        // valor pagado, fecha de pago, medio, día del cruce) ni lo que pasó al
        // encabezado de la sección (inscripción y programa).
        const ficha: [string, React.ReactNode][] = [
          ["Vence", fmt(row.fecha_vencimiento)],
          ["Valor cuota", fmtMonto(row.valor_cuota)],
          ["Valor a cobrar", fmtMonto(row.valor_a_cobrar)],
          ["Abono del Excel", row.pago ? fmtMonto(Math.round(numPago(row.pago))) : "—"],
          ["Moneda", fmt(row.moneda)],
          ["Correo", fmt(row.correo_elec)],
        ];
        if ((row.cuotas_inscripcion ?? 1) > 1) {
          ficha.splice(1, 0, ["Cuotas de la inscripción", String(row.cuotas_inscripcion)]);
        }

        // ── EL TITULAR ───────────────────────────────────────────────────────
        // 🔴 El número grande es la DIFERENCIA, no el monto del pago: es lo que
        // decide si en esta cuota hay trabajo. El monto pagado queda abajo, en
        // letra chica, como de dónde sale.
        // ⚠️ El orden de las ramas importa: una cuota cerrada puede ser además
        // parcial o tener saldo, y lo que manda es que está cerrada (no hay nada
        // que hacerle). Y `pendiente` va antes que `parcial`/`saldoFavor` porque
        // sin pago la diferencia no describe nada.
        const difAbs  = Math.abs(row.diferencia ?? 0);
        const aCobrar = row.valor_a_cobrar ?? 0;
        // El porcentaje cubierto. `null` = no se pinta la barra: en una cuota
        // cerrada no hay nada que decidir, y sin `valor_a_cobrar` no hay contra
        // qué medir (dividir por cero daría una barra llena, que miente).
        const pctCubierto = aCobrar > 0
          ? Math.max(0, Math.min(100, ((row.valor_pago ?? 0) / aCobrar) * 100))
          : null;
        const titular =
          cerrada || cerradaPorCartera
            ? { estado: cerradaPorCartera ? "Cerrada por Cartera" : "Cerrada",
                monto: fmtMonto(row.valor_pago ?? row.valor_cuota),
                detalle: cerradaPorCartera
                  ? "la cobró el proceso manual"
                  : `cerrada con el pago aplicado${row.fecha_cruce ? ` el ${row.fecha_cruce}` : ""}`,
                tono: "text-gray-400", barra: "bg-gray-300", pct: null as number | null }
          : pendiente
            ? { estado: "Sin pago identificado", monto: fmtMonto(row.valor_a_cobrar),
                detalle: `es lo que debe · vence ${fmt(row.fecha_vencimiento)}`,
                tono: "text-gray-900", barra: "bg-gray-300", pct: 0 }
          : parcial
            ? { estado: "Le falta", monto: fmtMonto(difAbs),
                detalle: `pagó ${fmtMonto(row.valor_pago)} de ${fmtMonto(row.valor_a_cobrar)}`,
                tono: "text-orange-700", barra: "bg-orange-500", pct: pctCubierto }
          : saldoFavor
            ? { estado: "Le sobra", monto: fmtMonto(difAbs),
                detalle: `pagó ${fmtMonto(row.valor_pago)} de ${fmtMonto(row.valor_a_cobrar)}`,
                tono: "text-teal-700", barra: "bg-teal-600", pct: pctCubierto }
            : { estado: "Pagada completa", monto: fmtMonto(row.valor_pago),
                detalle: `cubre la cuota de ${fmtMonto(row.valor_a_cobrar)}`,
                tono: "text-teal-700", barra: "bg-teal-600", pct: pctCubierto };

        // ── LA CRONOLOGÍA ────────────────────────────────────────────────────
        // Todo sale de la MISMA fila: no se consulta nada y no se deduce nada que
        // la fila no diga. Un hito sin su fecha no se inventa — simplemente no
        // entra (regla 5.1: sin dato, nada).
        const PUNTO = {
          gris:  "bg-white border-gray-300",
          brand: "bg-brand-600 border-brand-600",
          ok:    "bg-teal-600 border-teal-600",
          alerta:"bg-orange-500 border-orange-500",
        };
        const crono: { t1: string; t2: string; punto: string }[] = [
          { t1: "Vencía", t2: `${fmt(row.fecha_vencimiento)} · ${fmtMonto(row.valor_cuota)}`, punto: PUNTO.gris },
        ];
        if (row.pago && Math.round(numPago(row.pago)) > 0) {
          crono.push({ t1: "Abono traído por el Excel",
                       t2: fmtMonto(Math.round(numPago(row.pago))), punto: PUNTO.gris });
        }
        if (row.fecha_pago) {
          crono.push({ t1: "Pago recibido",
                       t2: [row.fecha_pago, row.medio_pago, row.valor_pago != null ? fmtMonto(row.valor_pago) : null]
                             .filter(Boolean).join(" · "),
                       punto: PUNTO.brand });
        }
        if (row.fecha_cruce) {
          crono.push({ t1: cerradaPorCartera ? "Declarada pagada por Cartera" : "Cruzada",
                       t2: `${row.fecha_cruce}${cerradaPorCartera ? "" : parcial ? " · no alcanzó a cubrirla" : " · cubrió la cuota"}`,
                       punto: cerradaPorCartera ? PUNTO.gris : parcial ? PUNTO.alerta : PUNTO.ok });
        }
        if (!pendiente && parcial) {
          crono.push({ t1: `Quedó corta por ${fmtMonto(difAbs)}`,
                       t2: avisoSinAplicar
                         ? "menos del umbral: no nació su cuota de deuda"
                         : "la deuda baja como una línea aparte",
                       punto: PUNTO.alerta });
        }
        if (!pendiente && saldoFavor) {
          crono.push({ t1: `Sobró ${fmtMonto(difAbs)}`,
                       t2: "queda como saldo a favor del documento", punto: PUNTO.ok });
        }
        if (avisoSinAplicar) {
          crono.push({ t1: "Esperando que alguien la asocie",
                       t2: "el pago siguiente no se aplica solo", punto: PUNTO.alerta });
        }
        return (
          <>
            <div className="px-4 py-3 border-b border-black/[0.06] flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 truncate">Cuota {fmt(row.llave)}</p>
                <p className="text-[11px] text-gray-500 truncate">
                  {fmt(row.cliente)} · doc {fmt(row.cruce_access)}
                </p>
              </div>
              <button
                onClick={() => setCajonLlave(null)}
                aria-label="Cerrar el cajón"
                title="Cerrar (Esc)"
                className="text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg w-6 h-6 flex items-center justify-center active:scale-95 transition-all duration-200 ease-(--ease-spring)"
              >
                ✕
              </button>
            </div>

            {/* `key` por llave: al cambiar de cuota sin cerrar el cajón, el
                contenido entra con la animación en vez de saltar de golpe — es lo
                que hace notar que lo que se está mirando cambió. */}
            <div key={row.llave} className="animate-fade-in flex-1 overflow-y-auto">

              {/* El aviso del pipeline (2026-08-21) como FRANJA, no como texto
                  gris: es el único de la pantalla que pide una acción concreta
                  —asociar esa plata a mano— y el monto viaja dentro del texto. */}
              {avisoSinAplicar && (
                <p className="px-4 py-2 text-[11px] bg-amber-50 text-amber-800 border-b border-amber-200/80">
                  <span className="font-semibold">{row.notificacion}</span> — hay plata esperando que alguien la asocie.
                </p>
              )}

              {/* EL TITULAR. Lo que decide el trabajo es la DIFERENCIA, no el
                  monto: es el número por el que se abre el cajón. El monto pagado
                  baja a letra chica. 🔴 El color se usa una sola vez por cajón —
                  acá— y de ahí sale el estado; repartirlo por toda la ficha es lo
                  que hacía que no se leyera ninguno. */}
              <div className="px-4 pt-3.5 pb-3 border-b border-black/[0.06]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-[11.5px] font-semibold ${titular.tono}`}>{titular.estado}</p>
                    <p className={`text-[27px] leading-tight font-semibold tabular-nums tracking-tight ${titular.tono}`}>
                      {titular.monto}
                    </p>
                    <p className="text-[11px] text-gray-500 tabular-nums mt-0.5">{titular.detalle}</p>
                  </div>
                  {/* Los badges se dejan encoger (`min-w-0 max-w-[48%]`): hay
                      notificaciones largas —"1 CUOTA + ABONO", "PAGA DOS CUOTAS"—
                      y con `shrink-0` empujarían el titular fuera de la caja. */}
                  <div className="flex flex-col items-end gap-1 min-w-0 max-w-[48%] text-right">
                    {paymentBadge(row)}
                    {!avisoSinAplicar && row.notificacion && notificacionBadge(row)}
                  </div>
                </div>
                {/* La barra dice cuánto se cubrió sin leer un número. No se pinta
                    en una cuota cerrada (no hay nada que decidir) ni cuando no hay
                    contra qué medir. */}
                {titular.pct != null && (
                  <div className="mt-2.5 h-[5px] rounded-full bg-gray-200 overflow-hidden">
                    <div className={`h-full ${titular.barra}`} style={{ width: `${titular.pct}%` }} />
                  </div>
                )}
                {/* Las mismas señales de la celda, repetidas acá: con el cajón
                    abierto la fila puede quedar fuera de la vista. */}
                {rowMessage[row.llave] && <p className="mt-2 text-[11px] text-green-700">{rowMessage[row.llave]}</p>}
                {rowError[row.llave] && <p className="mt-2 text-[11px] text-red-600">{rowError[row.llave]}</p>}
              </div>

              {/* La tira de los tres datos que se miran de reojo. */}
              <div className="flex border-b border-black/[0.06]">
                {([["Pagó", fmt(row.fecha_pago)], ["Medio", fmt(row.medio_pago)], ["Cruce", fmt(row.fecha_cruce)]] as const).map(([k, v], i) => (
                  <div key={k} className={`flex-1 min-w-0 px-3 py-2 ${i < 2 ? "border-r border-black/[0.05]" : ""}`}>
                    <p className="text-[9.5px] uppercase tracking-wider text-gray-400">{k}</p>
                    <p className="text-[11.5px] text-gray-900 truncate mt-0.5">{v}</p>
                  </div>
                ))}
              </div>

              {/* La ficha, en SOLO LECTURA — las tres casillas editables (vence,
                  valor de cuota y abono) se quedan en su columna de la tabla, que
                  es el único sitio que las escribe. */}
              <div className="border-b border-black/[0.06]">
                <div className="px-4 py-2 bg-gray-50 flex items-center justify-between gap-2">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-gray-600">La cuota</p>
                  <span className="text-[10.5px] text-gray-500 truncate">
                    {fmt(row.inscrip)} · {fmt(row.programa)}
                  </span>
                </div>
                <dl className="px-4 py-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
                  {ficha.map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-gray-500 whitespace-nowrap">{k}</dt>
                      <dd className="text-gray-900 text-right tabular-nums truncate">{v}</dd>
                    </Fragment>
                  ))}
                </dl>
                {(cerrada || yaCobrada) && (
                  <p className="px-4 pb-2.5 -mt-1 text-[11px] text-gray-400">
                    {cerrada ? "Cuota cerrada" : "Ya cobrada en el Sistema Financiero"}
                  </p>
                )}
              </div>

              {/* LA CRONOLOGÍA. Las cuatro fechas que la ficha enseña como cuatro
                  renglones iguales —vence, pago, cruce, y lo que pasó con el
                  sobrante o el faltante— puestas en orden. Es lo que convierte la
                  ficha en una explicación: se lee de dónde salió la diferencia sin
                  restar nada de cabeza. Sale toda de la misma fila, no se consulta
                  nada nuevo. */}
              <div className="border-b border-black/[0.06]">
                <div className="px-4 py-2 bg-gray-50">
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-gray-600">Cronología</p>
                </div>
                <ol className="px-4 py-3 pl-8">
                  {crono.map((ev, i) => (
                    <li key={i} className={`relative ${i < crono.length - 1 ? "pb-3" : ""}`}>
                      <span className={`absolute -left-[14px] top-[3px] w-2 h-2 rounded-full border-2 ${ev.punto}`} />
                      {i < crono.length - 1 && (
                        <span className="absolute -left-[10.5px] top-[13px] bottom-0 w-px bg-gray-200" />
                      )}
                      <p className="text-[11.5px] font-semibold text-gray-900">{ev.t1}</p>
                      <p className="text-[10.5px] text-gray-500 tabular-nums">{ev.t2}</p>
                    </li>
                  ))}
                </ol>
              </div>

              {/* Los formularios. Son los mismos de antes, palabra por palabra:
                  lo único que cambió es dónde se dibujan y que acá van en una
                  columna en vez de uno al lado del otro. */}
              <div className="px-4 py-3 flex flex-col gap-3">
                        {cierreOpen[row.llave] && (
                          <div className="animate-fade-in bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1.5">
                            <label className="block text-[11px] text-gray-500">Fecha de pago</label>
                            <input
                              type="date"
                              value={cierreFecha[row.llave] || ""}
                              onChange={(e) => setCierreFecha((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                            />
                            <p className="text-[11px] text-gray-400">Medio: Cartera · Valor: {fmtMonto(parseMonto(cuotaEdits[row.llave] ?? row.valor_cuota))}</p>
                            <button
                              onClick={() => handleCerrarCartera(row)}
                              disabled={saving}
                              className="w-full text-xs px-2 py-1.5 rounded-lg bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                            >
                              {saving ? "Guardando..." : "Confirmar cierre"}
                            </button>
                          </div>
                        )}
                        {/* Descartar y marcar pagada por Cartera: pide la fecha
                            APENAS se abre (requisito del usuario) y lista lo que va a
                            soltar antes de tocar nada. */}
                        {descartarCerrarOpen[row.llave] && (
                          <div className="animate-fade-in bg-slate-50 border border-slate-200 rounded-lg p-2 space-y-1.5">
                            <p className="text-[11px] font-medium text-slate-700">Descartar y marcar pagada por Cartera</p>
                            <label className="block text-[11px] text-gray-500">Fecha de pago</label>
                            <input
                              type="date"
                              value={cierreFecha[row.llave] || ""}
                              onChange={(e) => setCierreFecha((prev) => ({ ...prev, [row.llave]: e.target.value }))}
                              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                            />
                            {descartarLoading[row.llave] ? (
                              <p className="text-xs text-gray-500">Cargando...</p>
                            ) : descartarError[row.llave] ? (
                              <p className="text-xs text-red-600">{descartarError[row.llave]}</p>
                            ) : asociacionesDeLaCuota.length === 0 ? (
                              // Guarda: sin asociación viva, Confirmar cerraría la cuota
                              // sin soltar nada y el pago quedaría comido.
                              <p className="text-[11px] text-gray-500">No hay pagos asociados a descartar.</p>
                            ) : (
                              <>
                                <p className="text-[11px] text-gray-500">Se van a soltar:</p>
                                {asociacionesDeLaCuota.map((asociacion) => (
                                  <p key={asociacion.id} className="text-[11px] text-gray-600 bg-white border border-gray-200 rounded px-1.5 py-1">
                                    {/* El monto es el de la ASOCIACIÓN, nunca el de la
                                        columna "Valor Pago": esa muestra lo que entró
                                        por el pago, no lo aplicado a esta cuota. */}
                                    {fmt(asociacion.transaction_code_1)} · {fmt(asociacion.payment_date)} · {fmtMonto(asociacion.monto)}
                                  </p>
                                ))}
                                <p className="text-[11px] text-gray-400">Medio: Cartera · Valor: {fmtMonto(parseMonto(cuotaEdits[row.llave] ?? row.valor_cuota))}</p>
                                <p className="text-[11px] text-amber-700">
                                  &quot;Reabrir&quot; devuelve la cuota a pendiente pero no vuelve a pegar el pago:
                                  queda como saldo a favor y hay que asociarlo a mano.
                                </p>
                                <button
                                  onClick={() => handleDescartarYCerrar(row)}
                                  disabled={savingDyC}
                                  className="w-full text-xs px-2 py-1.5 rounded-lg bg-slate-700 text-white hover:bg-slate-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
                                >
                                  {savingDyC ? "Procesando..." : "Confirmar"}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                        {/* ── El panel de asociar, por CUOTA ─────────────────────────
                            Hasta el 2026-10-02 esto preguntaba "este pago, ¿a qué cuota
                            va?": recorría los pagos y, dentro de cada uno, TODAS las
                            cuotas destino del documento. La cuota en la que se había
                            apretado no participaba —era una más de la lista, sin ninguna
                            marca—, así que se elegía "una random de las que están ahí" y
                            la plata se iba a otra cuota sin que nada avisara. Es lo que
                            pasó el 2 de octubre con el documento 1099208759.

                            Ahora la cuota destino está FIJA (es la fila) y el panel es
                            una lista de ORIGEN de plata: los pagos del documento con
                            restante, los saldos a favor, y el envío a otro documento. */}
                        {(ofrecePagos || tieneSaldo) && (
                          <div className="animate-fade-in -mx-4 border-y border-black/[0.06]">
                            {/* El encabezado nombra la cuota: es lo que deja sin duda a
                                dónde va la plata que se apriete abajo. Desde el cajón el
                                nombre ya está arriba y fijo, así que acá queda la línea
                                que SÍ cambia por cuota: qué le falta. */}
                            <div className="px-4 py-2 bg-gray-50 flex items-center justify-between gap-2">
                              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-gray-600">
                                Plata que le puede entrar
                              </p>
                              {/* 🔴 `cuotaRestante` NO es "lo que le falta": en una cuota con
                                  saldo a favor vale el SOBRANTE (es |diferencia|), así que
                                  decía "le falta $63" en una cuota que no necesita un peso.
                                  Acá se pregunta por el estado, no por el número. El valor
                                  en sí no se toca: lo usan los botones "Todo" (1.13). */}
                              {/* La pastilla dice LA PLATA que hay para esta cuota cuando
                                  la hay (es el número que se va a repartir); si no hay saldo,
                                  dice qué le falta. */}
                              <span className={`text-[10.5px] font-semibold tabular-nums whitespace-nowrap px-2 py-0.5 rounded-full border ${
                                tieneSaldo
                                  ? "bg-teal-50 text-teal-700 border-teal-200"
                                  : pendiente || parcial
                                    ? "bg-orange-50 text-orange-700 border-orange-200"
                                    : "bg-gray-100 text-gray-600 border-gray-200"
                              }`}>
                                {tieneSaldo
                                  ? fmtMonto(grupo!.total)
                                  : pendiente || parcial ? `le falta ${fmtMonto(cuotaRestante)}` : "ya está cubierta"}
                              </span>
                            </div>
                            <div className="px-4 py-2.5 space-y-2">
                            {/* Por qué los botones de asociar pueden no estar. Se escribe
                                arriba, no al apretar: el servidor también lo rechaza
                                (409), pero enterarse antes es la diferencia. */}
                            {cerradaPorCartera && (
                              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200/80 rounded-lg px-2 py-1.5">{ERROR_CERRADA_POR_CARTERA}</p>
                            )}
                            {!cerradaPorCartera && row.original_abierta && (
                              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200/80 rounded-lg px-2 py-1.5">
                                Esta es una línea de falta de pago y su cuota original sigue abierta: la plata
                                se asocia en la original, o se pagaría dos veces la misma deuda.
                              </p>
                            )}
                            <div className="flex flex-col gap-3">
                            {/* ── 1. Los pagos del documento con plata sin repartir ── */}
                            {ofrecePagos && (
                            <div className="space-y-1">
                            {asociarLoading[row.cruce_access] ? (
                              <p className="text-xs text-gray-500">Cargando...</p>
                            ) : asociarError[row.cruce_access] ? (
                              <p className="text-xs text-red-600">{asociarError[row.cruce_access]}</p>
                            ) : (
                              <>
                                {(() => {
                                  const pagosDelDoc = asociarData[row.cruce_access]?.pagos || [];
                                  return pagosDelDoc.length === 0 ? (
                                    <p className="text-[11px] text-gray-500">
                                      No hay pagos de este documento con plata por repartir.
                                    </p>
                                  ) : (
                                    <>
                                      <p className="text-[11px] text-gray-500">
                                        {pagosDelDoc.length} pago(s) de este documento con plata sin repartir
                                      </p>
                                      {pagosDelDoc.map((pago) => {
                                        // §4.3: "Todo" PROPONE lo razonable — el menor entre lo
                                        // que le queda al pago y lo que le falta a la cuota. Antes
                                        // proponía el restante entero del pago, que es lo que
                                        // convertía un clic rápido en un sobrepago. No BLOQUEA: la
                                        // casilla "otro $" acepta más, porque desde el 14/09 una
                                        // cuota ya cubierta sí puede recibir plata (y es lo que
                                        // hace que la fila diga "PAGA N CUOTAS").
                                        // ⚠️ El `|| pago.restante` no es decorativo: en una cuota ya
                                        // cubierta `cuotaRestante` es 0 y "Todo" no propondría nada.
                                        const montoTodo = Math.min(pago.restante, cuotaRestante || pago.restante);
                                        const exacto = Math.abs(cuotaRestante - pago.restante) < 1;
                                        const actionKey = `${pago.matching_key}:${row.llave}`;
                                        const savingAction = rowSaving === actionKey;
                                        // Todo lo que se teclea va por PAGO y por CUOTA: el panel
                                        // ahora puede estar abierto en dos cuotas de la misma
                                        // persona, y una llave por documento compartiría el valor.
                                        const otroValorKey = actionKey;
                                        const key = `${row.llave}:${pago.matching_key}`;
                                        const destino = enviarDestino[key];
                                        const docDestino = (enviarDocInput[key] || "").trim();
                                        const savingEnvio = rowSaving === `enviar:${key}`;
                                        const montoEnvio = enviarMontoInput[key]
                                          ? parseMonto(enviarMontoInput[key])
                                          : pago.restante;
                                        const montoValido = Number.isFinite(montoEnvio) && montoEnvio > 0
                                          && montoEnvio <= pago.restante + 0.01;
                                        return (
                                          <div key={pago.matching_key} className="py-1.5 space-y-1 border-b border-dashed border-gray-200 last:border-b-0">
                                            {/* El monto va A LA DERECHA y alineado: es la columna
                                                que se compara de un vistazo cuando hay varios pagos.
                                                Dentro del texto obliga a leer renglón por renglón. */}
                                            <div className="flex items-baseline justify-between gap-2">
                                              <p className="text-[11px] text-gray-600 truncate min-w-0">
                                                {fmt(pago.transaction_code_1)} · {fmt(pago.payment_date)} · restante
                                                {exacto && <span className="text-emerald-700 font-medium"> ✓ calza</span>}
                                              </p>
                                              <p className={`text-xs font-semibold tabular-nums shrink-0 ${exacto ? "text-emerald-700" : "text-gray-900"}`}>
                                                {fmtMonto(pago.restante)}
                                              </p>
                                            </div>
                                            <div className="flex items-center gap-1.5 text-[11px] pt-2 mt-1.5 border-t border-dashed border-gray-200">
                                              {puedeAsociarPago && (<>
                                                <button
                                                  onClick={() => handleAsociar(row, pago, montoTodo)}
                                                  disabled={savingAction}
                                                  className="px-2 py-1 rounded-lg bg-brand-700 text-white font-medium hover:bg-brand-800 disabled:opacity-50"
                                                >
                                                  {cuotaRestante && cuotaRestante < pago.restante ? "Todo lo que falta" : "Todo"}
                                                </button>
                                                <input
                                                  type="text"
                                                  inputMode="numeric"
                                                  placeholder={formatMonto(montoTodo)}
                                                  value={montoOtroValor[otroValorKey] || ""}
                                                  onChange={(e) => setMontoOtroValor((prev) => ({ ...prev, [otroValorKey]: e.target.value }))}
                                                  onBlur={(e) => setMontoOtroValor((prev) => ({ ...prev, [otroValorKey]: formatMonto(e.target.value) }))}
                                                  className="w-24 border border-gray-300 rounded-lg px-2 py-1"
                                                />
                                                <button
                                                  onClick={() => {
                                                    const monto = parseMonto(montoOtroValor[otroValorKey]);
                                                    if (Number.isFinite(monto) && monto > 0) handleAsociar(row, pago, monto);
                                                  }}
                                                  disabled={savingAction}
                                                  className="px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                                                >
                                                  OK
                                                </button>
                                              </>)}
                                              {/* Enviar a otro documento: un pago puede ser de dos
                                                  personas (una empresa por su empleado, un familiar
                                                  por otro). Va siempre, incluso donde no se puede
                                                  asociar — ahí suele ser la única salida. */}
                                              <button
                                                onClick={() => setEnviarOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
                                                className="ml-auto px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
                                              >
                                                {enviarOpen[key] ? "Ocultar envío" : "Enviar a otro doc."}
                                              </button>
                                            </div>
                                              {enviarOpen[key] && (
                                                <div className="animate-fade-in mt-1 space-y-1 bg-indigo-50/60 border border-indigo-200/80 rounded-lg p-1.5">
                                                  <div className="flex items-center gap-1">
                                                    <input
                                                      type="text"
                                                      placeholder="Documento destino"
                                                      value={enviarDocInput[key] || ""}
                                                      onChange={(e) => {
                                                        setEnviarDocInput((prev) => ({ ...prev, [key]: e.target.value }));
                                                        setEnviarDestino((prev) => ({ ...prev, [key]: null }));
                                                      }}
                                                      className="flex-1 min-w-0 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                                    />
                                                    <button
                                                      onClick={() => handleBuscarDestino(key, docDestino)}
                                                      disabled={!docDestino || enviarBuscando[key]}
                                                      className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                                    >
                                                      {enviarBuscando[key] ? "..." : "Buscar"}
                                                    </button>
                                                  </div>
                                                  {destino && (
                                                    destino.inscripciones.length === 0 ? (
                                                      <p className="text-[11px] text-red-600">
                                                        Ese documento no tiene cuotas abiertas en la cartera: la plata no se
                                                        vería en ninguna pantalla.
                                                      </p>
                                                    ) : (
                                                      <>
                                                        <p className="text-[11px] text-indigo-900">
                                                          ✓ {fmt(destino.cliente)}
                                                        </p>
                                                        <p className="text-[11px] text-indigo-700">
                                                          {destino.inscripciones.length} inscripción(es) con cuotas abiertas
                                                          ({destino.inscripciones.join(", ")}) · debe {fmtMonto(destino.debe)}
                                                        </p>
                                                        <div className="flex items-center gap-1">
                                                          <input
                                                            type="text"
                                                            inputMode="numeric"
                                                            placeholder={formatMonto(pago.restante)}
                                                            value={enviarMontoInput[key] || ""}
                                                            onChange={(e) => setEnviarMontoInput((prev) => ({ ...prev, [key]: e.target.value }))}
                                                            onBlur={(e) => setEnviarMontoInput((prev) => ({ ...prev, [key]: formatMonto(e.target.value) }))}
                                                            className="w-24 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                                          />
                                                          <button
                                                            onClick={() => handleEnviarSaldo(row, pago, docDestino, montoEnvio)}
                                                            disabled={savingEnvio || !montoValido}
                                                            title={montoValido ? undefined : `A este pago solo le quedan ${fmtMonto(pago.restante)}`}
                                                            className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-700 text-white hover:bg-indigo-800 disabled:opacity-50"
                                                          >
                                                            {savingEnvio ? "Enviando..." : "Enviar saldo"}
                                                          </button>
                                                        </div>
                                                        <p className="text-[11px] text-gray-500">
                                                          Por defecto se envía todo el restante. La plata llega como saldo a
                                                          favor de esa persona y allá se asocia a la cuota que corresponda.
                                                        </p>
                                                      </>
                                                    )
                                                  )}
                                                  {enviarError[key] && (
                                                    <p className="text-[11px] text-red-600">{enviarError[key]}</p>
                                                  )}
                                                </div>
                                              )}
                                          </div>
                                        );
                                      })}
                                    </>
                                  );
                                })()}
                              </>
                            )}
                            </div>
                            )}
                            {/* Puede quedar vacío sin que nadie cierre el panel: al
                                asociar el último saldo, su fila sale del ledger. Sin esta
                                línea el panel quedaría con el encabezado solo. */}
                            {!ofrecePagos && !tieneSaldo && (
                              <p className="text-[11px] text-gray-500">
                                Ya no queda plata de este documento por repartir.
                              </p>
                            )}
                            {/* ── 2. Los saldos a favor del documento ──────────────── */}
                            {tieneSaldo && (
                          <div className="space-y-1">
                            {/* Decía "Esta inscripción tiene un saldo a favor de X". Con
                                el panel por cuota eso se lee como si el saldo fuera de la
                                cuota de la fila, y no: es del DOCUMENTO (o del correo), y
                                desde acá se le puede meter a ESTA cuota. */}
                            <div className="animate-fade-in space-y-1 pt-1">
                              {grupo!.rows.map((saldo) => {
                                  const otroKey = `saldo:${saldo.id}:${row.llave}`;
                                  const savingAction = rowSaving === otroKey;
                                  const montoTodo = Math.min(saldo.disponible, cuotaRestante || saldo.disponible);
                                  // El envío se lleva por fila de ledger Y por cuota a la
                                  // vista: el mismo saldo se muestra en todas las cuotas de
                                  // la persona, y compartir el estado haría que escribir el
                                  // documento en una abriera el panel en todas.
                                  const envKey   = `${row.llave}:s${saldo.id}`;
                                  const destino  = enviarDestino[envKey];
                                  const docDest  = (enviarDocInput[envKey] || "").trim();
                                  const savingEnvio = rowSaving === `enviar:${envKey}`;
                                  // Por defecto, TODO lo disponible de ESTA fila — no lo del
                                  // pago entero, que puede tener plata en otras filas y en el
                                  // restante libre. Son botones distintos y cada uno mueve lo
                                  // suyo.
                                  const montoEnvio = enviarMontoInput[envKey]
                                    ? parseMonto(enviarMontoInput[envKey])
                                    : Number(saldo.disponible);
                                  const montoValido = Number.isFinite(montoEnvio) && montoEnvio > 0
                                    && montoEnvio <= Number(saldo.disponible) + 0.01;
                                  return (
                                    <div key={saldo.id} className="py-1.5 space-y-1 border-b border-dashed border-gray-200 last:border-b-0">
                                      <div className="flex items-baseline justify-between gap-2">
                                        <div className="min-w-0">
                                          {/* "del documento", no "de la cuota": el saldo es de la
                                              persona y desde acá se le mete a ESTA cuota. */}
                                          <p className="text-[11px] text-gray-900">Saldo del documento</p>
                                          <p className="text-[10.5px] text-gray-500 truncate">
                                            {fmt(saldo.cliente)} · {fmt(saldo.fecha)} · disponible
                                          </p>
                                        </div>
                                        <p className="text-xs font-semibold tabular-nums text-gray-900 shrink-0">
                                          {fmtMonto(saldo.disponible)}
                                        </p>
                                      </div>
                                      {/* Un envío se puede deshacer SOLO mientras nadie lo haya
                                          asociado: si ya se usó una parte, la plata está en una
                                          cuota y el camino es "Descartar pago" allá. El servidor
                                          revalida lo mismo y responde 409. */}
                                      {saldo.origen === "traslado" && (
                                        <div className="flex items-center gap-1">
                                          <span className="text-[11px] text-indigo-700">Enviado desde otro documento</span>
                                          {Number(saldo.disponible) === Number(saldo.monto) && (
                                            <button
                                              onClick={() => handleDeshacerTraslado(row, saldo)}
                                              disabled={rowSaving === `deshacer:${saldo.id}`}
                                              className="text-[11px] px-1.5 py-0.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                                            >
                                              {rowSaving === `deshacer:${saldo.id}` ? "..." : "Deshacer envío"}
                                            </button>
                                          )}
                                        </div>
                                      )}
                                      {/* Asociar a ESTA cuota va también cuando la cuota ya está
                                          cubierta — es lo que hace que la notificación diga
                                          "PAGA N CUOTAS" en vez de dejar la fila en "Pagada
                                          completa · Diferencia $0" con el doble pagado. Lo único
                                          que no recibe plata es una línea de deuda con su cuota
                                          original abierta. Enviar a otra persona va siempre: el
                                          caso normal es una cuota ya pagada cuyo sobrante es de
                                          otra cédula. */}
                                      {/* Una sola fila: asociar acá y mandar a otra persona son
                                          los dos caminos de esta plata y se eligen a la vez. */}
                                      <div className="flex items-center gap-1.5 text-[11px] pt-2 mt-1.5 border-t border-dashed border-gray-200">
                                        {puedeAsociarSaldo && (<>
                                          <button
                                            onClick={() => handleAsociarSaldo(row, saldo, montoTodo)}
                                            disabled={savingAction}
                                            className="px-2 py-1 rounded-lg bg-brand-700 text-white font-medium hover:bg-brand-800 disabled:opacity-50"
                                          >
                                            {cuotaRestante && cuotaRestante < saldo.disponible ? "Todo lo que falta" : "Todo"}
                                          </button>
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            placeholder="otro $"
                                            value={saldoOtroValor[otroKey] || ""}
                                            onChange={(e) => setSaldoOtroValor((prev) => ({ ...prev, [otroKey]: e.target.value }))}
                                            onBlur={(e) => setSaldoOtroValor((prev) => ({ ...prev, [otroKey]: formatMonto(e.target.value) }))}
                                            className="w-24 border border-gray-300 rounded-lg px-2 py-1"
                                          />
                                          <button
                                            onClick={() => {
                                              const monto = parseMonto(saldoOtroValor[otroKey]);
                                              if (Number.isFinite(monto) && monto > 0) handleAsociarSaldo(row, saldo, monto);
                                            }}
                                            disabled={savingAction}
                                            className="px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                                          >
                                            OK
                                          </button>
                                        </>)}
                                        <button
                                          onClick={() => setEnviarOpen((prev) => ({ ...prev, [envKey]: !prev[envKey] }))}
                                          className="ml-auto px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 active:scale-95 transition-all duration-200 ease-(--ease-spring)"
                                        >
                                          {enviarOpen[envKey] ? "Ocultar envío" : "Enviar a otro doc."}
                                        </button>
                                      </div>
                                        {enviarOpen[envKey] && (
                                          <div className="animate-fade-in mt-1 space-y-1 bg-indigo-50/60 border border-indigo-200/80 rounded-lg p-1.5">
                                            <div className="flex items-center gap-1">
                                              <input
                                                type="text"
                                                placeholder="Documento destino"
                                                value={enviarDocInput[envKey] || ""}
                                                onChange={(e) => {
                                                  setEnviarDocInput((prev) => ({ ...prev, [envKey]: e.target.value }));
                                                  setEnviarDestino((prev) => ({ ...prev, [envKey]: null }));
                                                }}
                                                className="flex-1 min-w-0 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                              />
                                              <button
                                                onClick={() => handleBuscarDestino(envKey, docDest)}
                                                disabled={!docDest || enviarBuscando[envKey]}
                                                className="text-[11px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                              >
                                                {enviarBuscando[envKey] ? "..." : "Buscar"}
                                              </button>
                                            </div>
                                            {destino && (
                                              destino.inscripciones.length === 0 ? (
                                                <p className="text-[11px] text-red-600">
                                                  Ese documento no tiene cuotas abiertas en la cartera: la plata no se
                                                  vería en ninguna pantalla.
                                                </p>
                                              ) : (
                                                <>
                                                  {/* El nombre a la vista es lo único que deja notar
                                                      que se erró el documento antes de mandarle plata
                                                      a un desconocido. */}
                                                  <p className="text-[11px] text-indigo-900">✓ {fmt(destino.cliente)}</p>
                                                  <p className="text-[11px] text-indigo-700">
                                                    {destino.inscripciones.length} inscripción(es) con cuotas abiertas
                                                    ({destino.inscripciones.join(", ")}) · debe {fmtMonto(destino.debe)}
                                                  </p>
                                                  <div className="flex items-center gap-1">
                                                    <input
                                                      type="text"
                                                      inputMode="numeric"
                                                      placeholder={formatMonto(saldo.disponible)}
                                                      value={enviarMontoInput[envKey] || ""}
                                                      onChange={(e) => setEnviarMontoInput((prev) => ({ ...prev, [envKey]: e.target.value }))}
                                                      onBlur={(e) => setEnviarMontoInput((prev) => ({ ...prev, [envKey]: formatMonto(e.target.value) }))}
                                                      className="w-24 text-[11px] border border-gray-300 rounded px-1 py-0.5"
                                                    />
                                                    <button
                                                      onClick={() => handleEnviarSaldoFavor(row, saldo, envKey, docDest, montoEnvio)}
                                                      disabled={savingEnvio || !montoValido}
                                                      title={montoValido ? undefined : `Ese saldo solo tiene ${fmtMonto(saldo.disponible)} disponibles`}
                                                      className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-700 text-white hover:bg-indigo-800 disabled:opacity-50"
                                                    >
                                                      {savingEnvio ? "Enviando..." : "Enviar saldo"}
                                                    </button>
                                                  </div>
                                                  <p className="text-[11px] text-gray-500">
                                                    Por defecto se envía todo lo disponible de este saldo. La plata llega
                                                    como saldo a favor de esa persona y allá se asocia a la cuota que
                                                    corresponda.
                                                  </p>
                                                </>
                                              )
                                            )}
                                            {enviarError[envKey] && (
                                              <p className="text-[11px] text-red-600">{enviarError[envKey]}</p>
                                            )}
                                          </div>
                                        )}
                                    </div>
                                  );
                              })}
                            </div>
                          </div>
                            )}
                            </div>
                            </div>
                          </div>
                        )}
                        {descartarOpen[row.llave] && (
                          <div className="animate-fade-in bg-red-50/60 border border-red-200/80 rounded-lg p-2 space-y-1.5">
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
              </div>
            </div>
            {/* 🔴 Las acciones viven en un PIE FIJO, fuera del cuerpo que
                desplaza: son el final del trabajo y en una cuota con cronología
                larga quedaban debajo de todo. El pie solo existe si hay algo que
                apretar — una cuota sin acciones no muestra una barra vacía. */}
            {acciones.length > 0 && (
              <div className="shrink-0 border-t border-black/[0.06] bg-white px-4 py-2.5 flex flex-wrap gap-1.5">
                {acciones.map((accion) => (
                  <button
                    key={accion.key}
                    onClick={accion.onClick}
                    disabled={saving}
                    title={accion.title}
                    className={`text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 ${accion.className}`}
                  >
                    {accion.label}
                  </button>
                ))}
              </div>
            )}
          </>
        );
      })()}
        </div>
      </aside>
    </div>
  );
}
