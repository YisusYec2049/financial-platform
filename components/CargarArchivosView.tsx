"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  BUCKET,
  ETIQUETA_FUENTE,
  FUENTES_BANCOS,
  FUENTES_CRUCE,
  PAYU_PAR,
  REVISION,
  avisoDeCuenta,
  nuevoIdSoltado,
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
  /**
   * Dónde quedó la copia del apartado de revisión, o `null` si no se pudo
   * dejar ahí. Es lo que se **mueve** a la bandeja al apretar Subir.
   */
  rutaRevision: string | null;
  /** El veredicto del pipeline sobre este archivo, desde que se soltó. */
  revision: Revision | null;
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

/**
 * El veredicto del pipeline sobre un archivo recién soltado.
 *
 * 🔴 **Los tres primeros los decide el pipeline, no esta pantalla** (§3 de la
 * spec): acá no hay ninguna lista de hojas, columnas ni nombres esperados. Los
 * otros dos son estados de esta app: mientras se espera la respuesta, y cuando
 * no se pudo preguntar.
 */
type Veredicto = "ok" | "archivo_incorrecto" | "formato_incorrecto" | "revisando" | "sin_revisar";

const VEREDICTOS_DEL_PIPELINE = ["ok", "archivo_incorrecto", "formato_incorrecto"] as const;

interface Revision {
  estado: Veredicto;
  /** Las filas que leyó. Es lo que delata un archivo cortado a la mitad. */
  filas: number | null;
  /** Cómo se llama el archivo que esa caja espera. Viene escrito del pipeline. */
  espera: string | null;
}

/**
 * Lo que devuelve `/api/cruce/trigger/status`, que es el estado completo del
 * carril del pipeline. Solo se nombran los dos campos que esta pantalla mira.
 */
interface EstadoCorrida {
  status: string;          // idle | running | done | error
  exit_code: number | null;
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

/**
 * El código con el que `sync_cartera.py` **frena** la corrida a propósito
 * cuando un archivo de cruce se subió y no se pudo leer (`SALIDA_CRUCE_ILEGIBLE`).
 *
 * 🔴 No es un número inventado ni intercambiable con el fallo genérico (`1`):
 * existe justamente para que esta pantalla pueda decir dos cosas distintas. Una
 * corrida frenada no procesa **ningún** pago, y hasta hoy se leía igual que una
 * corrida sin trabajo — el caso del 21 de septiembre, con 188 pagos esperando
 * dos horas detrás de un *"No entró ningún archivo nuevo"*.
 */
const SALIDA_CRUCE_ILEGIBLE = 3;

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
 * El texto que ve el área debajo del nombre del archivo.
 *
 * 🔴 **Los dos textos en rojo van EXACTOS, palabra por palabra.** Los dictó el
 * usuario el 2026-09-21 y ya se reescribieron una vez por cuenta propia. Lo
 * único variable es el nombre después de *"se espera el archivo"*, y sale del
 * campo `espera` que manda el pipeline — **no se arma acá**: en la caja de
 * Cartera se suben dos archivos distintos (la normal y la Preventiva, las dos
 * válidas) y por eso ahí el texto dice "CARTERA" a secas.
 *
 * La diferencia entre los dos rojos, para saber qué está diciendo cada uno:
 * *"Archivo incorrecto"* = esto no es el archivo de esta caja, subieron otra
 * cosa; *"Formato del archivo incorrecto"* = sí es el archivo, pero le
 * cambiaron algo adentro y hay que corregirlo.
 */
function textoRevision(r: Revision): string {
  switch (r.estado) {
    case "revisando":
      return "Revisando…";
    case "ok":
      return r.filas != null ? `Listo · ${r.filas.toLocaleString("es-CO")} filas` : "Listo";
    case "archivo_incorrecto":
      return r.espera
        ? `Archivo incorrecto, se espera el archivo ${r.espera}`
        : "Archivo incorrecto.";
    case "formato_incorrecto":
      return "Formato del archivo incorrecto, por favor corregir.";
    default:
      return "No se pudo revisar";
  }
}

const esRojo = (r: Revision | undefined): boolean =>
  r?.estado === "archivo_incorrecto" || r?.estado === "formato_incorrecto";

/**
 * Los colores de la tarjeta de un archivo que ya está en la entrada.
 *
 * ⚠️ **Sin revisión la tarjeta va NEUTRA, no verde.** Antes del semáforo todas
 * eran verdes, porque el verde decía "ya está en la entrada"; desde hoy el
 * verde dice **"lo revisó el pipeline y sirve"**, y dejarlo puesto sobre un
 * archivo sin revisar sería exactamente el semáforo que miente en verde que
 * este cambio viene a evitar. Pasa de verdad: al recargar la página, los
 * archivos que ya estaban ahí no tienen veredicto (§4.4 — se revisa una sola
 * vez, al subir).
 */
function colorTarjeta(r: Revision | undefined): string {
  if (esRojo(r)) return "bg-red-50 border-red-200 text-red-900";
  if (r?.estado === "ok") return "bg-emerald-50/70 border-emerald-200/70 text-emerald-900";
  return "bg-gray-50 border-gray-200 text-gray-700";
}

/**
 * El color de la tarjeta se lava **de un estado al otro**, no salta.
 *
 * ⚠️ Van `transition-colors` y no `transition-all`: lo único que cambia es el
 * color. Animar todo le agregaría movimiento a una fila que **no se mueve de
 * lugar** —el archivo sigue donde lo soltaron— y eso es justo lo que se pidió
 * evitar: sin parpadeos y sin saltos.
 */
const LAVADO_DE_COLOR = "transition-colors duration-[420ms] ease-out";

/**
 * El renglón del veredicto, con su propia entrada suave.
 *
 * 🔴 **Se usa SIEMPRE con `key={revision.estado}`** (ver los dos sitios que lo
 * llaman), y eso no es decoración: `animate-fade-in` es una animación CSS y solo
 * corre **al montar**, así que sin cambiar la `key` el texto pasaría de
 * "Revisando…" a "Listo · 11.089 filas" de golpe mientras el fondo se lava
 * despacio. Con la `key`, React remonta el renglón y el texto nuevo entra con él.
 */
function LineaRevision({ r }: { r: Revision }) {
  const enCurso = r.estado === "revisando";
  return (
    <p className={`animate-fade-in ${esRojo(r) ? "font-medium" : "opacity-80"}`}>
      {/* ⚠️ El latido va en un `<span>` adentro, no en el `<p>`: las dos clases
          escriben la propiedad `animation`, así que juntas una anula a la otra y
          se perdería la entrada suave. */}
      <span className={enCurso ? "animate-pulse" : undefined}>{textoRevision(r)}</span>
    </p>
  );
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
  revisiones,
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
  /** El veredicto de cada archivo de la entrada, por su ruta en el depósito. */
  revisiones: Record<string, Revision>;
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
            /* La tarjeta se pinta con el veredicto del archivo **desde que se
               suelta**, sin esperar a que nadie apriete nada. Entra con una
               entrada suave (`animate-fade-in`, una sola vez al soltarlo) y
               después solo se lava de color. */
            <div
              key={p.id}
              className={`text-[11px] rounded-lg border px-2.5 py-2 space-y-1.5 animate-fade-in ${LAVADO_DE_COLOR} ${colorTarjeta(
                p.revision ?? undefined
              )}`}
            >
              <div className="flex items-start gap-2">
                <span className="break-all flex-1">{p.file.name}</span>
                <span className="opacity-70 whitespace-nowrap">{fmtTamano(p.file.size)}</span>
                <button
                  onClick={() => onQuitarPreparado(p.id)}
                  disabled={p.estado === "subiendo"}
                  title="Quitar de la lista"
                  className="opacity-70 transition-opacity duration-200 hover:text-red-600 hover:opacity-100 disabled:opacity-40"
                >
                  ✕
                </button>
              </div>

              {p.revision && <LineaRevision key={p.revision.estado} r={p.revision} />}

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

              {p.estado === "subiendo" && (
                <p className="opacity-70 animate-pulse">Subiendo…</p>
              )}
              {p.estado === "error" && <p className="text-red-600 animate-fade-in">{p.error}</p>}
            </div>
          ))}

          {/* Lo que ya está en la entrada esperando la próxima corrida */}
          {esperando.map((a) => {
            const rev = revisiones[a.ruta];
            return (
              <div
                key={a.ruta}
                className={`text-[11px] rounded-lg border px-2.5 py-2 space-y-1 animate-fade-in ${LAVADO_DE_COLOR} ${colorTarjeta(
                  rev
                )}`}
              >
                <div className="flex items-start gap-2">
                  <span className="break-all flex-1">
                    {a.nombre}
                    <span className="opacity-70"> · esperando</span>
                    {a.lote && <span className="opacity-70"> · lote {a.lote}</span>}
                  </span>
                  <span className="opacity-70 whitespace-nowrap">{fmtTamano(a.tamano)}</span>
                  <button
                    onClick={() => onQuitarDeposito(a.ruta)}
                    disabled={quitando === a.ruta || corriendo}
                    title={corriendo ? "Hay una corrida en curso" : "Quitar del depósito antes de procesarlo"}
                    className="opacity-70 transition-opacity duration-200 hover:text-red-600 hover:opacity-100 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </div>

                {/* El veredicto, debajo del nombre. 🔴 El rojo AVISA, no
                    bloquea: el archivo se queda en su caja y se reemplaza con
                    el ✕ de arriba. El freno del pipeline ya protege la plata,
                    así que un bloqueo acá no agrega seguridad — solo quita
                    salidas, y un semáforo que además prohibe es uno que el área
                    va a querer esquivar el día que se equivoque. */}
                {rev && <LineaRevision key={rev.estado} r={rev} />}
              </div>
            );
          })}
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
  /** El veredicto de cada archivo, por su ruta en el depósito (§4). */
  const [revisiones, setRevisiones] = useState<Record<string, Revision>>({});

  const [procesados, setProcesados] = useState<Procesado[]>([]);
  const [totalProcesados, setTotalProcesados] = useState(0);
  const [soloErrores, setSoloErrores] = useState(false);

  const [corriendo, setCorriendo] = useState(false);
  const [resultadoCorrida, setResultadoCorrida] = useState("");
  /** El mensaje de arriba es de una corrida que falló o se frenó: va en rojo. */
  const [corridaFallo, setCorridaFallo] = useState(false);

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

  /**
   * Se llama cuando el carril del pipeline deja de estar `running`, con el
   * estado completo que devolvió el servidor.
   *
   * 🔴 **"Ya no está corriendo" NO es "terminó bien".** Hasta hoy el mensaje
   * salía de contar archivos nuevos en el registro, así que una corrida que
   * reventó a los 3 segundos decía *"No entró ningún archivo nuevo"* — que se
   * lee como "no había nada que hacer". Lo que distingue las dos es el código
   * de salida, y ya viene en el estado: no hace falta ninguna consulta nueva.
   *
   * ⚠️ En el caso del freno **no se averigua cuál archivo fue**: el pipeline ya
   * lo anotó en `archivos_procesados` con `resultado = "error"` y su motivo, y
   * aparece solo en la lista de abajo con la recarga que ya se hace acá.
   */
  const alTerminar = useCallback(async (estado: EstadoCorrida | null) => {
    stopPolling();
    setCorriendo(false);
    await Promise.all([fetchPendientes(), fetchProcesados()]);

    // ⚠️ Los archivos que frenaron la corrida SIGUEN en pendientes, a propósito:
    // es lo que deja reemplazarlos. La lista de arriba no se vacía, y está bien.
    const fallo =
      estado?.status === "error" || (estado?.exit_code != null && estado.exit_code !== 0);
    if (fallo) {
      setCorridaFallo(true);
      setResultadoCorrida(
        estado?.exit_code === SALIDA_CRUCE_ILEGIBLE
          ? "No se procesó ningún pago: hay un archivo de cruce que no se pudo leer. Corregilo y volvé a procesar."
          : "La corrida falló. Revisá el detalle o avisá a soporte."
      );
      return;
    }
    setCorridaFallo(false);

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
        if (json.status !== "running") alTerminar(json);
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
    setCorridaFallo(false);
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

  /* ── El semáforo (§4) ───────────────────────────────────────────────────── */

  /**
   * Le pregunta al pipeline si ese archivo sirve para la caja donde cayó.
   *
   * 🔴 **Un veredicto que no se entiende NO se pinta.** Cualquier sorpresa
   * —error de red, timeout, un estado que esta versión no conoce— cae en el
   * estado neutro "No se pudo revisar", nunca en verde ni en rojo: un semáforo
   * caído tiene que dejar trabajar, y uno que inventa un color deja de servir.
   */
  const pedirVeredicto = useCallback(async (ruta: string, fuente: string): Promise<Revision> => {
    try {
      const res = await fetch("/api/archivos/revisar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruta, fuente }),
      });
      const json = await res.json();
      if (res.ok && VEREDICTOS_DEL_PIPELINE.includes(json?.estado)) {
        return {
          estado: json.estado as Veredicto,
          filas: typeof json.filas === "number" ? json.filas : null,
          espera: typeof json.espera === "string" ? json.espera : null,
        };
      }
    } catch {
      // Cae en "sin_revisar".
    }
    return { estado: "sin_revisar", filas: null, espera: null };
  }, []);

  /**
   * Deja el archivo en el **apartado de revisión** y pide el veredicto, apenas se
   * suelta y sin que nadie apriete nada.
   *
   * 🔴 **El archivo se sube acá una sola vez en su vida.** El pipeline revisa
   * leyendo el archivo del depósito, así que para revisarlo antes de que entre a
   * la bandeja tiene que estar subido en algún lado — y mandárselo por el cuerpo
   * de una petición de esta app chocaría con el límite de ~4,5 MB de Vercel, o
   * sea que fallaría justo con la cartera. `revision/` es ese "algún lado", y el
   * pipeline **no lo lista nunca**: un archivo ahí no existe para la corrida.
   * Al apretar Subir se **mueve** a `entrada/`; no se vuelve a subir.
   *
   * ⚠️ **El lote de PayU no se decide acá**: se arma sobre la tanda que se sube
   * junta, o sea al apretar Subir.
   */
  const editarPreparado = (id: string, cambios: Partial<Preparado>) =>
    setPreparados((prev) => prev.map((p) => (p.id === id ? { ...p, ...cambios } : p)));

  const soltarEnApartado = async (p: Preparado) => {
    editarPreparado(p.id, {
      revision: { estado: "revisando", filas: null, espera: null },
      error: "",
    });

    try {
      const res = await fetch("/api/archivos/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: p.file.name,
          fuente: p.fuente,
          zona: REVISION,
          id: nuevoIdSoltado(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "No se pudo preparar la revisión");

      const supabase = createClient();
      const { error: errSubida } = await supabase.storage
        .from(BUCKET)
        .uploadToSignedUrl(json.ruta, json.token, p.file);
      if (errSubida) throw new Error(errSubida.message);

      editarPreparado(p.id, { rutaRevision: json.ruta });
      editarPreparado(p.id, { revision: await pedirVeredicto(json.ruta, p.fuente) });
    } catch {
      // ⚠️ Si el archivo no llegó al apartado no se puede revisar, pero **sí se
      // puede subir**: `handleSubir` vuelve al camino de siempre (subida directa
      // a la bandeja) cuando no hay copia en revisión. El área no se queda sin
      // poder trabajar porque el depósito tuvo un hipo.
      editarPreparado(p.id, {
        rutaRevision: null,
        revision: { estado: "sin_revisar", filas: null, espera: null },
      });
    }
  };

  /** Suelta la copia del apartado. Sin esto, cada archivo soltado por error se queda ahí. */
  const borrarDelApartado = (ruta: string | null) => {
    if (!ruta) return;
    void fetch("/api/archivos/revision", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruta }),
    }).catch(() => null);
  };

  const quitarPreparado = (id: string) => {
    borrarDelApartado(preparados.find((p) => p.id === id)?.rutaRevision ?? null);
    setPreparados((prev) => prev.filter((p) => p.id !== id));
  };

  /* ── Soltar archivos en una caja ────────────────────────────────────────── */

  const agregarArchivos = async (files: FileList | File[], fuente: string) => {
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
          rutaRevision: null,
          revision: null,
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

      // La revisión arranca sola, apenas se soltó y sin esperar a nadie. Cada
      // archivo va por su cuenta: con la cartera en la tanda, encadenarlos
      // dejaría a los demás sin veredicto durante segundos.
      for (const n of nuevos) void soltarEnApartado(n);
    } finally {
      setLeyendo(false);
    }
  };

  /* ── Subir ──────────────────────────────────────────────────────────────── */

  /**
   * Listo para subir = sin aviso pendiente de confirmar y **sin veredicto rojo**.
   *
   * 🔴 **Un archivo en rojo no se sube, y eso cambia la regla anterior** ("el
   * rojo avisa, no bloquea"). Cambió la situación, no el criterio: esa regla
   * hablaba de un archivo **que ya estaba en la bandeja**, donde sacarlo con la ✕
   * es el arreglo. Acá todavía no entró, y dejarlo entrar no tiene ninguna
   * ventaja — un archivo que el pipeline no puede abrir ahora tampoco lo va a
   * poder abrir en la corrida.
   *
   * ⚠️ **"No se pudo revisar" NO es rojo y sí se sube**: con el servicio de
   * revisión caído el área tiene que poder seguir trabajando, con el freno del
   * pipeline como red. Lo mismo mientras dice "Revisando…": el veredicto llega
   * antes de que nadie termine de soltar el resto de la tanda.
   */
  const estaListo = (p: Preparado) =>
    p.estado !== "listo" &&
    (!p.repetido || p.confirmadoRepetido) &&
    (!p.avisoCuenta || p.confirmadoCuenta) &&
    !esRojo(p.revision ?? undefined);

  const subibles = preparados.filter(estaListo);
  const conAvisoSinResolver = preparados.filter(
    (p) => p.estado !== "listo" && !estaListo(p) && !esRojo(p.revision ?? undefined)
  ).length;
  const enRojo = preparados.filter((p) => esRojo(p.revision ?? undefined)).length;
  /**
   * Los que todavía no tienen veredicto. **No bloquean Subir** —el §5 solo frena
   * lo rojo—, pero se dicen: apretar Subir un segundo después de soltar movería
   * el archivo antes de que llegue la respuesta, y el veredicto se perdería.
   */
  const revisandose = preparados.filter((p) => p.revision?.estado === "revisando").length;

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
        const cuerpo = {
          fuente: p.fuente,
          nombre: p.file.name,
          huella: p.huella,
          lote,
          tamano: p.file.size,
        };

        if (p.rutaRevision) {
          // 🔴 El archivo ya está en el depósito desde que se soltó: acá solo se
          // **mueve** del apartado a la bandeja, con su nombre final y su lote.
          // No se vuelve a subir — el archivo viaja una sola vez desde el
          // navegador, que es lo que esquiva el límite de ~4,5 MB de Vercel.
          const res = await fetch("/api/archivos/revision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...cuerpo, desde: p.rutaRevision }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || "No se pudo subir el archivo");

          // El veredicto viaja con el archivo: la tarjeta de la bandeja sigue
          // mostrando lo que se revisó, en vez de volver a gris sin motivo.
          // ⚠️ Solo si YA hay veredicto: si alguien apretó Subir mientras decía
          // "Revisando…", copiar ese estado dejaría la tarjeta de la bandeja
          // revisándose para siempre — la respuesta va a llegar a una ruta que ya
          // no existe.
          const veredicto = p.revision;
          if (veredicto && veredicto.estado !== "revisando") {
            setRevisiones((prev) => ({ ...prev, [json.ruta]: veredicto }));
          }
        } else {
          // ⚠️ Camino de reserva: el archivo nunca llegó al apartado (un fallo
          // del depósito al soltarlo), así que se sube directo a la bandeja como
          // antes de que el semáforo existiera. Sin esto, un hipo al soltar
          // dejaría el archivo sin forma de entrar.

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
            body: JSON.stringify({ ...cuerpo, ruta: json.ruta }),
          }).catch(() => null);
        }

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
    // Lo que quedó en rojo se queda en su caja con su mensaje, y el mensaje de
    // arriba lo dice: si no, "3 archivo(s) subido(s)" sobre una tanda de 4 se lee
    // como que entraron todos.
    setMensaje(
      ok
        ? `${ok} archivo(s) subido(s). Ya pueden procesarse.` +
            (enRojo ? ` ${enRojo} no se subió: revisá el mensaje en su caja.` : "")
        : ""
    );
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

  /**
   * ¿Hay algún archivo **de cruce** en rojo?
   *
   * Mira los **soltados** (que es donde vive hoy el veredicto) y también los que
   * ya están en la bandeja, por si uno entró antes de que el semáforo existiera o
   * por el camino de reserva.
   *
   * Solo los de cruce: son los que se leen **antes** que los pagos, así que uno
   * ilegible frena la cadena entera y no entra **ningún** pago — es el caso del
   * 21 de septiembre. Un banco en rojo estropea lo suyo y nada más, y para eso
   * ya está su propia tarjeta.
   */
  const esDeCruce = (fuente: string) => FUENTES_CRUCE.some((f) => f.value === fuente);
  const cruceEnRojo =
    preparados.some((p) => esDeCruce(p.fuente) && esRojo(p.revision ?? undefined)) ||
    pendientes.some((a) => esDeCruce(a.fuente) && esRojo(revisiones[a.ruta]));

  /** Las props que toda caja necesita y no dependen de su fuente. */
  const propsCaja = {
    revisiones,
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
          {resultadoCorrida && (
            <span
              className={`text-xs ${corridaFallo ? "text-red-700 font-medium" : "text-gray-600"}`}
            >
              {resultadoCorrida}
            </span>
          )}
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

      {/* Los tres avisos entran con `animate-slide-down`: aparecen empujando la
          página, así que caer de golpe es lo que se lee como parpadeo. */}
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2 animate-slide-down">{error}</div>
      )}
      {mensaje && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200/80 rounded-xl px-3.5 py-2 animate-slide-down">{mensaje}</div>
      )}
      {cruceEnRojo && (
        <div className="text-sm text-red-800 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2 animate-slide-down">
          Hay un archivo de cruce con problemas. Si procesás así, la corrida se va a frenar y no va a
          entrar ningún pago.
        </div>
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
        <div className={`${PANEL} px-6 py-4 flex items-center gap-3 flex-wrap sticky bottom-4 z-20 animate-fade-in`}>
          <button
            onClick={handleSubir}
            disabled={subiendo || leyendo || !subibles.length}
            className="text-sm px-3.5 py-1.5 rounded-full bg-brand-700 text-white hover:bg-brand-800 active:scale-95 transition-all duration-200 ease-(--ease-spring) disabled:opacity-50"
          >
            {subiendo ? "Subiendo..." : leyendo ? "Leyendo..." : `Subir ${subibles.length} archivo(s)`}
          </button>
          {revisandose > 0 && (
            <span className="text-xs text-gray-500 animate-pulse">{revisandose} revisándose…</span>
          )}
          {enRojo > 0 && (
            <span className="text-xs text-red-700 font-medium animate-fade-in">
              {enRojo} no se va a subir: mirá el mensaje en su caja
            </span>
          )}
          {conAvisoSinResolver > 0 && (
            <span className="text-xs text-amber-700 animate-fade-in">
              {conAvisoSinResolver} con un aviso sin confirmar
            </span>
          )}
          {payuDesparejado && (
            <span className="text-xs text-amber-700 animate-fade-in">{payuDesparejado}</span>
          )}
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
