"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  BUCKET,
  ETIQUETA_FUENTE,
  FUENTES_BANCOS,
  FUENTES_CRUCE,
  PAYU_PAR,
  avisoDeCuenta,
  nuevoLote,
  type Fuente,
} from "@/lib/fuentes";

/* ────────────────────────────────────────────────────────────────────────────
   Tipos
   ──────────────────────────────────────────────────────────────────────────── */

type EstadoSubida = "pendiente" | "subiendo" | "listo" | "error";

/** Un archivo que alguien soltó en una caja y todavía no se sube. */
interface Preparado {
  id: string;
  file: File;
  /** La caja donde se soltó. Ya no se elige ni se adivina: la caja ES la fuente. */
  fuente: string;
  huella: string;
  /** El contenido ya se procesó antes (§5 de la spec original). */
  repetido: Repetido | null;
  confirmadoRepetido: boolean;
  /** El nombre dice otra cuenta de Bancolombia (§4). */
  avisoCuenta: string | null;
  confirmadoCuenta: boolean;
  estado: EstadoSubida;
  error: string;
}

interface Repetido {
  huella: string;
  procesado_at: string;
  pagos_nuevos: number | null;
  nombre: string;
  fuente: string;
  resultado: string;
}

interface ArchivoPendiente {
  ruta: string;
  fuente: string;
  nombre: string;
  lote: string;
  tamano: number | null;
  subido_at: string | null;
  subido_por: string | null;
}

interface Procesado {
  id: number;
  fuente: string;
  nombre: string;
  tamano_bytes: number | null;
  origen: string;
  lote: string | null;
  subido_por: string | null;
  procesado_at: string;
  filas_leidas: number | null;
  pagos_nuevos: number | null;
  resultado: string;
  detalle: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────────── */

const PANEL =
  "bg-white rounded-2xl border border-black/[0.06] shadow-[0_1px_1px_rgba(0,0,0,0.03),0_8px_20px_-12px_rgba(0,0,0,0.15)]";

function fmtTamano(b: number | null): string {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtFecha(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  // Hora de Colombia, no la del navegador: `procesado_at` viene en UTC y una
  // corrida de la noche se vería un día corrida.
  return d.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * SHA-256 del contenido, igual que `utils/registro.py:huella()` del pipeline.
 * `crypto.subtle` ya viene en el navegador; no hace falta ninguna dependencia.
 * Verificado el 2026-09-06 que da lo mismo que `sha256sum`.
 */
async function huellaDe(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ────────────────────────────────────────────────────────────────────────────
   Una caja: su propia zona de arrastre, con el nombre de la fuente encima.
   La caja donde se suelta el archivo ES la fuente — no hay desplegable ni se
   adivina por el nombre (§1 y §6.1 de la spec: la misma fuente llega con
   nombres completamente distintos, `stripe.csv` y `unified_payments (43).csv`
   son el mismo banco).

   ⚠️ Vive a nivel de módulo a propósito. Definida dentro de la vista sería un
   componente nuevo en cada render, y React remontaría las 13 cajas cada vez que
   cambia cualquier cosa — perdiendo el resaltado del arrastre y el input.
   ──────────────────────────────────────────────────────────────────────────── */

function Caja({
  fuente,
  nota,
  esperando,
  enCaja,
  corriendo,
  quitando,
  onSoltar,
  onQuitarPreparado,
  onEditarPreparado,
  onQuitarDeposito,
}: {
  fuente: Fuente;
  nota?: string;
  esperando: ArchivoPendiente[];
  enCaja: Preparado[];
  corriendo: boolean;
  quitando: string | null;
  onSoltar: (files: FileList | File[], fuente: string) => void;
  onQuitarPreparado: (id: string) => void;
  onEditarPreparado: (id: string, cambios: Partial<Preparado>) => void;
  onQuitarDeposito: (ruta: string) => void;
}) {
  const [sobre, setSobre] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="border border-black/[0.07] rounded-xl bg-white overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1.5">
        {/* Solo el nombre. Sin ejemplo de archivo debajo — ver la nota de
            `FUENTES` en lib/fuentes.ts. */}
        <h3 className="text-[13px] font-semibold text-gray-900 leading-tight">{fuente.label}</h3>
        {nota && <p className="text-[10px] text-brand-700 mt-0.5 leading-snug">{nota}</p>}
      </div>

      {/* `flex-1`: con la nota del par, las cajas de PayU son más altas que las
          demás. Sin esto la zona de arrastre queda a distinta altura en cada
          columna y la cuadrícula se ve desalineada. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setSobre(true); }}
        onDragLeave={() => setSobre(false)}
        onDrop={(e) => {
          e.preventDefault();
          setSobre(false);
          onSoltar(e.dataTransfer.files, fuente.value);
        }}
        onClick={() => inputRef.current?.click()}
        className={`mx-3 mb-3 flex-1 flex flex-col items-center justify-center cursor-pointer rounded-lg border-2 border-dashed px-2 py-3.5 text-center transition-colors duration-200 ${
          sobre ? "border-brand-400 bg-brand-50/60" : "border-gray-200 hover:border-brand-300 hover:bg-gray-50/70"
        }`}
      >
        <svg className="w-4 h-4 text-gray-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
        <p className="text-[10px] text-gray-500 leading-tight">Arrastrá el archivo acá</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onSoltar(e.target.files, fuente.value);
            e.target.value = "";
          }}
        />
      </div>

      {(enCaja.length > 0 || esperando.length > 0) && (
        <div className="px-3.5 pb-3 space-y-2">
          {/* Lo que se acaba de soltar y todavía no se sube */}
          {enCaja.map((p) => (
            <div key={p.id} className="text-[11px] border border-gray-200 rounded-lg px-2.5 py-2 space-y-1.5">
              <div className="flex items-start gap-2">
                <span className="text-gray-800 break-all flex-1">{p.file.name}</span>
                <span className="text-gray-400 whitespace-nowrap">{fmtTamano(p.file.size)}</span>
                <button
                  onClick={() => onQuitarPreparado(p.id)}
                  disabled={p.estado === "subiendo"}
                  title="Quitar de la lista"
                  className="text-gray-400 hover:text-red-600 disabled:opacity-40"
                >
                  ✕
                </button>
              </div>

              {p.avisoCuenta && (
                <div className="bg-amber-50 border border-amber-200/80 rounded px-2 py-1.5 space-y-1">
                  <p className="text-amber-900">{p.avisoCuenta}</p>
                  <label className="flex items-center gap-1.5 text-amber-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={p.confirmadoCuenta}
                      onChange={(e) => onEditarPreparado(p.id, { confirmadoCuenta: e.target.checked })}
                      className="rounded"
                    />
                    Sí, va acá
                  </label>
                </div>
              )}

              {p.repetido && (
                <div className="bg-amber-50 border border-amber-200/80 rounded px-2 py-1.5 space-y-1">
                  <p className="text-amber-900">
                    Ya se procesó el {fmtFecha(p.repetido.procesado_at)}
                    {p.repetido.pagos_nuevos != null && ` y dejó ${p.repetido.pagos_nuevos} pago(s)`}.
                  </p>
                  <label className="flex items-center gap-1.5 text-amber-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={p.confirmadoRepetido}
                      onChange={(e) => onEditarPreparado(p.id, { confirmadoRepetido: e.target.checked })}
                      className="rounded"
                    />
                    Subirlo de nuevo igual
                  </label>
                </div>
              )}

              {p.estado === "subiendo" && <p className="text-gray-500">Subiendo…</p>}
              {p.estado === "error" && <p className="text-red-600">{p.error}</p>}
            </div>
          ))}

          {/* Lo que ya está en la entrada esperando la próxima corrida */}
          {esperando.map((a) => (
            <div
              key={a.ruta}
              className="text-[11px] flex items-start gap-2 bg-emerald-50/70 border border-emerald-200/70 rounded-lg px-2.5 py-2"
            >
              <span className="text-emerald-900 break-all flex-1">
                {a.nombre}
                <span className="text-emerald-700/70"> · esperando</span>
                {a.lote && <span className="text-emerald-700/70"> · lote {a.lote}</span>}
              </span>
              <span className="text-emerald-700/70 whitespace-nowrap">{fmtTamano(a.tamano)}</span>
              <button
                onClick={() => onQuitarDeposito(a.ruta)}
                disabled={quitando === a.ruta || corriendo}
                title={corriendo ? "Hay una corrida en curso" : "Quitar del depósito antes de procesarlo"}
                className="text-emerald-700/70 hover:text-red-600 disabled:opacity-40"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Vista
   ──────────────────────────────────────────────────────────────────────────── */

export default function CargarArchivosView() {
  const [preparados, setPreparados] = useState<Preparado[]>([]);
  const [leyendo, setLeyendo] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");

  const [pendientes, setPendientes] = useState<ArchivoPendiente[]>([]);
  const [quitando, setQuitando] = useState<string | null>(null);

  const [procesados, setProcesados] = useState<Procesado[]>([]);
  const [totalProcesados, setTotalProcesados] = useState(0);
  const [soloErrores, setSoloErrores] = useState(false);

  const [corriendo, setCorriendo] = useState(false);
  const [resultadoCorrida, setResultadoCorrida] = useState("");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const corridaDesdeRef = useRef<number>(0);

  /* ── Datos del servidor ─────────────────────────────────────────────────── */

  const fetchPendientes = useCallback(async () => {
    try {
      const res = await fetch("/api/archivos/pendientes");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "No se pudo leer el depósito");
      setPendientes(json.archivos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al leer el depósito");
    }
  }, []);

  const fetchProcesados = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (soloErrores) params.set("solo_errores", "1");
      const res = await fetch(`/api/archivos/procesados?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "No se pudo leer el registro");
      setProcesados(json.data ?? []);
      setTotalProcesados(json.total ?? 0);
    } catch {
      // El registro es informativo: si falla, la pantalla sigue sirviendo para subir.
    }
  }, [soloErrores]);

  // ⚠️ Con IIFE `async` adentro, no llamando la función directo: el lint de este
  // proyecto rechaza llamar desde el cuerpo de un efecto a algo que hace
  // `setState`, incluso si el `setState` va después de un `await`.
  useEffect(() => {
    (async () => { await fetchPendientes(); })();
  }, [fetchPendientes]);

  useEffect(() => {
    (async () => { await fetchProcesados(); })();
  }, [fetchProcesados]);

  /* ── La corrida ─────────────────────────────────────────────────────────── */

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const alTerminar = useCallback(async () => {
    stopPolling();
    setCorriendo(false);
    await Promise.all([fetchPendientes(), fetchProcesados()]);

    // Cuántos pagos nuevos dejó cada archivo de ESTA corrida. Sale de
    // `archivos_procesados`, que llena el pipeline.
    try {
      const res = await fetch("/api/archivos/procesados");
      const json = await res.json();
      const desde = corridaDesdeRef.current;
      const nuevas: Procesado[] = (json.data ?? []).filter(
        (p: Procesado) => new Date(p.procesado_at).getTime() >= desde
      );
      if (!nuevas.length) {
        setResultadoCorrida("La corrida terminó. No entró ningún archivo nuevo.");
      } else {
        const pagos = nuevas.reduce((s, p) => s + (p.pagos_nuevos ?? 0), 0);
        const fallidos = nuevas.filter((p) => p.resultado === "error").length;
        setResultadoCorrida(
          `Terminó: ${nuevas.length} archivo(s), ${pagos} pago(s) nuevo(s)` +
            (fallidos ? ` · ${fallidos} con error` : "")
        );
      }
    } catch {
      setResultadoCorrida("La corrida terminó.");
    }
  }, [stopPolling, fetchPendientes, fetchProcesados]);

  const startPolling = useCallback(() => {
    stopPolling();
    // El estado se consulta con el endpoint que ya existe: es el mismo carril.
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/cruce/trigger/status");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar el estado");
        if (json.status !== "running") alTerminar();
      } catch {
        stopPolling();
        setCorriendo(false);
      }
    }, 5000);
  }, [stopPolling, alTerminar]);

  /**
   * Re-enganche al montar: si ya hay una corrida en curso —porque la persona
   * apretó y navegó a otra sección— se vuelve a seguir. El estado vive en el
   * servidor, que es un solo carril. Patrón del 2026-07-27 (`096fbdf`).
   */
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const res = await fetch("/api/cruce/trigger/status");
        const json = await res.json();
        if (vivo && json.status === "running") {
          corridaDesdeRef.current = Date.now();
          setCorriendo(true);
          startPolling();
        }
      } catch {
        // Sin estado, la pantalla arranca en reposo.
      }
    })();
    return () => { vivo = false; };
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProcesar = async () => {
    setResultadoCorrida("");
    setError("");
    setCorriendo(true);
    corridaDesdeRef.current = Date.now();
    try {
      const estado = await fetch("/api/cruce/trigger/status").then((r) => r.json());
      if (estado.status !== "running") {
        const res = await fetch("/api/archivos/trigger", { method: "POST" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "No se pudo iniciar el procesamiento");
      }
      startPolling();
    } catch (e) {
      setCorriendo(false);
      setError(e instanceof Error ? e.message : "Error inesperado");
    }
  };

  /* ── Soltar archivos en una caja ────────────────────────────────────────── */

  const agregarArchivos = useCallback(async (files: FileList | File[], fuente: string) => {
    const lista = Array.from(files);
    if (!lista.length) return;

    setError("");
    setMensaje("");
    setLeyendo(true);

    try {
      const nuevos: Preparado[] = [];
      for (const file of lista) {
        nuevos.push({
          id: `${fuente}-${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
          file,
          fuente,
          huella: await huellaDe(file),
          repetido: null,
          confirmadoRepetido: false,
          avisoCuenta: avisoDeCuenta(file.name, fuente),
          confirmadoCuenta: false,
          estado: "pendiente",
          error: "",
        });
      }

      // El aviso de repetido, antes de subir nada.
      try {
        const res = await fetch("/api/archivos/huellas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ huellas: nuevos.map((n) => n.huella) }),
        });
        const json = await res.json();
        const porHuella = new Map<string, Repetido>(
          (json.conocidas ?? []).map((c: Repetido) => [c.huella, c])
        );
        for (const n of nuevos) n.repetido = porHuella.get(n.huella) ?? null;
      } catch {
        // Sin registro no se puede avisar, pero se puede subir igual: el aviso
        // es una ayuda, no una condición.
      }

      setPreparados((prev) => [...prev, ...nuevos]);
    } finally {
      setLeyendo(false);
    }
  }, []);

  const quitarPreparado = (id: string) =>
    setPreparados((prev) => prev.filter((p) => p.id !== id));

  const editarPreparado = (id: string, cambios: Partial<Preparado>) =>
    setPreparados((prev) => prev.map((p) => (p.id === id ? { ...p, ...cambios } : p)));

  /* ── Subir ──────────────────────────────────────────────────────────────── */

  /** Listo para subir = sin aviso pendiente de confirmar. Los avisos no bloquean: se confirman. */
  const estaListo = (p: Preparado) =>
    p.estado !== "listo" &&
    (!p.repetido || p.confirmadoRepetido) &&
    (!p.avisoCuenta || p.confirmadoCuenta);

  const subibles = preparados.filter(estaListo);
  const conAvisoSinResolver = preparados.filter(
    (p) => p.estado !== "listo" && !estaListo(p)
  ).length;

  /**
   * El par de PayU: los dos archivos se suben con el MISMO prefijo de lote, y
   * eso es lo que reemplaza al emparejamiento **por orden de llegada** del
   * pipeline —un riesgo anotado desde agosto: un par mal armado no falla,
   * produce pagos con el monto de otra tanda.
   */
  const lotesDePayu = (items: Preparado[]): Map<string, string> => {
    const asignados = new Map<string, string>();
    const payu = items.filter((p) => p.fuente === PAYU_PAR[0]);
    const moneda = items.filter((p) => p.fuente === PAYU_PAR[1]);
    for (let i = 0; i < Math.min(payu.length, moneda.length); i++) {
      const lote = nuevoLote();
      asignados.set(payu[i].id, lote);
      asignados.set(moneda[i].id, lote);
    }
    return asignados;
  };

  const payuDesparejado = (() => {
    const payu = subibles.filter((p) => p.fuente === PAYU_PAR[0]).length;
    const moneda = subibles.filter((p) => p.fuente === PAYU_PAR[1]).length;
    if (payu === moneda) return "";
    const falta = payu > moneda ? ETIQUETA_FUENTE[PAYU_PAR[1]] : ETIQUETA_FUENTE[PAYU_PAR[0]];
    return `Falta el archivo de ${falta}: ese par no se procesa hasta que llegue el otro. Se guarda para la próxima.`;
  })();

  const handleSubir = async () => {
    if (!subibles.length) return;
    setSubiendo(true);
    setError("");
    setMensaje("");

    const lotes = lotesDePayu(subibles);
    const supabase = createClient();
    let ok = 0;

    for (const p of subibles) {
      editarPreparado(p.id, { estado: "subiendo", error: "" });
      try {
        const lote = lotes.get(p.id) ?? null;

        // 1. La app firma; por acá NO pasa el archivo.
        const res = await fetch("/api/archivos/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nombre: p.file.name, fuente: p.fuente, lote }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "No se pudo preparar la subida");

        // 2. El navegador sube DIRECTO al depósito, saltándose el límite de
        //    ~4,5 MB de Vercel. Ver §2 de la spec original.
        const { error: errSubida } = await supabase.storage
          .from(BUCKET)
          .uploadToSignedUrl(json.ruta, json.token, p.file);
        if (errSubida) throw new Error(errSubida.message);

        // 3. Se deja constancia de quién subió qué.
        await fetch("/api/archivos/registrar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ruta: json.ruta,
            fuente: p.fuente,
            nombre: p.file.name,
            huella: p.huella,
            lote,
            tamano: p.file.size,
          }),
        }).catch(() => null);

        editarPreparado(p.id, { estado: "listo" });
        ok++;
      } catch (e) {
        editarPreparado(p.id, {
          estado: "error",
          error: e instanceof Error ? e.message : "Error al subir",
        });
      }
    }

    setSubiendo(false);
    setMensaje(ok ? `${ok} archivo(s) subido(s). Ya pueden procesarse.` : "");
    // Los que quedaron bien salen de la caja: ya viven en el depósito.
    setPreparados((prev) => prev.filter((p) => p.estado !== "listo"));
    await fetchPendientes();
  };

  /* ── Quitar del depósito ────────────────────────────────────────────────── */

  const handleQuitar = async (ruta: string) => {
    setQuitando(ruta);
    setError("");
    try {
      const res = await fetch("/api/archivos/pendientes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruta }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "No se pudo quitar el archivo");
      await fetchPendientes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al quitar el archivo");
    } finally {
      setQuitando(null);
    }
  };

  /* ── Render ─────────────────────────────────────────────────────────────── */

  const esperandoTotal = pendientes.length;

  /** Las props que toda caja necesita y no dependen de su fuente. */
  const propsCaja = {
    corriendo,
    quitando,
    onSoltar: agregarArchivos,
    onQuitarPreparado: quitarPreparado,
    onEditarPreparado: editarPreparado,
    onQuitarDeposito: handleQuitar,
  };

  const renderCaja = (f: Fuente, nota?: string) => (
    <Caja
      key={f.value}
      fuente={f}
      nota={nota}
      esperando={pendientes.filter((a) => a.fuente === f.value)}
      enCaja={preparados.filter((p) => p.fuente === f.value)}
      {...propsCaja}
    />
  );

  return (
    <div className="p-5 pb-8 space-y-4">
      {corriendo && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 bg-white/95 backdrop-blur border border-gray-200 shadow-lg rounded-full pl-3 pr-4 py-2 animate-fade-in">
          <svg className="w-3.5 h-3.5 animate-spin text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          <span className="text-xs font-medium text-gray-700">Procesando…</span>
        </div>
      )}

      <div className={`${PANEL} animate-slide-down px-6 py-4 flex items-center justify-between flex-wrap gap-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-gray-900">Cargar archivos</h1>
          <span className="text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full font-medium">
            {esperandoTotal
              ? `${esperandoTotal} archivo(s) esperando a procesarse`
              : "Soltá cada archivo en su caja"}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {resultadoCorrida && <span className="text-xs text-gray-600">{resultadoCorrida}</span>}
          <button
            onClick={handleProcesar}
            disabled={corriendo}
            title="Corre el proceso sobre todo lo que esté en la entrada"
            className="flex items-center gap-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 px-3.5 py-1.5 rounded-full active:scale-95 transition-all duration-200 ease-(--ease-spring)"
          >
            <svg className={`w-3.5 h-3.5 ${corriendo ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {corriendo ? "Procesando..." : "Procesar archivos"}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2">{error}</div>
      )}
      {mensaje && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200/80 rounded-xl px-3.5 py-2">{mensaje}</div>
      )}

      {/* ── Archivos Cruce ── */}
      <div className={`${PANEL} animate-fade-in [animation-delay:60ms] px-6 py-5 space-y-3`}>
        {/* Solo el título: la descripción se quitó a pedido del usuario, por lo
            mismo que el ejemplo de nombre en cada caja. */}
        <h2 className="text-sm font-semibold text-gray-800">Archivos Cruce</h2>
        <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {FUENTES_CRUCE.map((f) => renderCaja(f))}
        </div>
      </div>

      {/* ── Ingresos de bancos ── */}
      <div className={`${PANEL} animate-fade-in [animation-delay:100ms] px-6 py-5 space-y-3`}>
        <h2 className="text-sm font-semibold text-gray-800">Ingresos de bancos</h2>
        {/* 5 columnas: son 9 cajas, así entran en DOS filas (5 + 4). Con 4
            columnas quedaban 3 filas y la última con una sola caja. */}
        <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {/* Las dos de PayU van juntas: ahí nace el lote, y así se ve por qué
              esperar al otro archivo no es un error. Nota corta a propósito: en
              una columna angosta, un texto largo estira esas dos cajas. */}
          {FUENTES_BANCOS.map((f) =>
            renderCaja(f, PAYU_PAR.includes(f.value) ? "Va en par: uno solo no se procesa." : undefined)
          )}
        </div>
      </div>

      {/* ── Barra de subida ── */}
      {preparados.length > 0 && (
        <div className={`${PANEL} px-6 py-4 flex items-center gap-3 flex-wrap sticky bottom-4 z-20`}>
          <button
            onClick={handleSubir}
            disabled={subiendo || leyendo || !subibles.length}
            className="text-sm px-3.5 py-1.5 rounded-full bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
          >
            {subiendo ? "Subiendo..." : leyendo ? "Leyendo..." : `Subir ${subibles.length} archivo(s)`}
          </button>
          {conAvisoSinResolver > 0 && (
            <span className="text-xs text-amber-700">
              {conAvisoSinResolver} con un aviso sin confirmar
            </span>
          )}
          {payuDesparejado && <span className="text-xs text-amber-700">{payuDesparejado}</span>}
        </div>
      )}

      {/* ── Últimas corridas ── */}
      <div className={`${PANEL} animate-fade-in [animation-delay:140ms] overflow-hidden`}>
        <div className="px-6 py-3 border-b border-black/[0.06] flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-gray-800">
            Últimos archivos procesados{" "}
            <span className="font-normal text-gray-500">({totalProcesados.toLocaleString("es-CO")})</span>
          </h2>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={soloErrores}
              onChange={(e) => setSoloErrores(e.target.checked)}
              className="rounded"
            />
            Solo los que fallaron
          </label>
        </div>
        <div className="overflow-auto max-h-[45vh]">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-gray-50 text-gray-500 text-left border-b border-black/[0.06]">
                <th className="px-4 py-3 font-medium whitespace-nowrap">Archivo</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Fuente</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Procesado</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Filas leídas</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Pagos nuevos</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Resultado</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Detalle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {procesados.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-gray-400">
                    {soloErrores ? "Ningún archivo falló" : "Todavía no se ha procesado ningún archivo"}
                  </td>
                </tr>
              ) : (
                procesados.map((p) => (
                  <tr
                    key={p.id}
                    className={`hover:bg-gray-50/70 transition-colors duration-100 ${p.resultado === "error" ? "bg-red-50/40" : ""}`}
                  >
                    <td className="px-4 py-2.5 text-gray-700 break-all">{p.nombre}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                      {ETIQUETA_FUENTE[p.fuente] ?? p.fuente}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{fmtFecha(p.procesado_at)}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{p.filas_leidas ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{p.pagos_nuevos ?? "—"}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {p.resultado === "error" ? (
                        <span className="bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded-full">Error</span>
                      ) : (
                        <span className="bg-emerald-50 text-emerald-700 text-xs px-2 py-0.5 rounded-full">OK</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 max-w-md break-words">{p.detalle ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
