import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sanitizeSearch } from "@/lib/search";

// "Cerrar Cartera" (spec 23/07 §2.2) — medida provisional hasta que todo esté
// completamente operativo.
//
// Cerrar una cuota = pasar el valor de `valor_pago` también a `pago`. El mismo
// número en los dos campos es como el Sistema Financiero representa una cuota
// cobrada. `valor_a_cobrar` se recalcula por el invariante valor_cuota - pago y
// NO se fuerza a cero: si la persona pagó de menos, el faltante queda a la vista,
// que es justo lo que el equipo usa para repartir la deuda en la cartera siguiente.
//
// Alcance: los filtros activos de la vista, incluido el de "Día del Cruce"
// (`fecha_cruce`, el día en que el sistema identificó el pago — no `fecha_pago`, que
// suele ser días antes). Sin ese filtro puesto, el día de hoy.
// La pantalla filtrada ES la revisión: no se filtra por diferencia, se cierra todo
// lo que esté ahí (los faltantes grandes no llegan a aparecer, el pipeline ya les
// abrió una cuota nueva; y la plata que sobra vive aparte en cartera_saldos_favor).
// ⚠️ Se trae por lotes, NO con .limit(MAX_ROWS). PostgREST devuelve como máximo
// 1.000 filas por respuesta y NO avisa: pedir 5.000 o 50.000 devuelve 1.000 las
// dos veces (comprobado el 2026-08-05). Como este endpoint decide QUÉ cuotas
// cierra, un cierre de un rango largo habría cerrado 1.000 y dicho que terminó —
// el modo de fallar que ya costó caro acá: "dice que sí y no hace nada".
const MAX_ROWS = 5000;
const BATCH = 1000;

type Fila = {
  llave: string;
  pago: string | null;
  pago_confirmado: number | null;
  valor_cuota: number | null;
  valor_pago: number | null;
};

const num = (v: string | number | null): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export async function POST(req: NextRequest) {
  const { user, response } = await requireAuth(req);
  if (response) return response;

  const body = await req.json().catch(() => ({}));
  const search       = typeof body?.search === "string" ? sanitizeSearch(body.search) : "";
  const estado       = typeof body?.estado === "string" ? body.estado : "todas";
  const vencFrom     = typeof body?.venc_from === "string" ? body.venc_from : "";
  const vencTo       = typeof body?.venc_to === "string" ? body.venc_to : "";
  const pagoParcial  = body?.pago_parcial === "1" || body?.pago_parcial === true;
  const medioPago    = typeof body?.medio_pago === "string" ? body.medio_pago.slice(0, 100) : "";
  const payFrom      = typeof body?.pay_from === "string" ? body.pay_from : "";
  const payTo        = typeof body?.pay_to === "string" ? body.pay_to : "";
  const cruceFrom    = typeof body?.cruce_from === "string" ? body.cruce_from : "";
  const cruceTo      = typeof body?.cruce_to === "string" ? body.cruce_to : "";
  const conNotificacion = body?.con_notificacion === "1" || body?.con_notificacion === true;
  const wompiTipo    = typeof body?.wompi_tipo === "string" ? body.wompi_tipo : "";
  const multiCuota   = body?.multi_cuota === "1" || body?.multi_cuota === true;

  // El día del cierre lo decide el cliente (su zona horaria), no el servidor.
  const hoy = typeof body?.dia === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dia)
    ? body.dia
    : new Date().toISOString().slice(0, 10);

  const supabase = createAdminClient();

  // Mismos filtros que GET /api/cartera-preventiva, más la condición de que haya algo
  // que copiar.
  // La anotación `typeof base` corta la inferencia en cada paso: sin ella, encadenar
  // ~13 filtros condicionales hace explotar el tipo del builder (TS2589).
  // La LECTURA va contra la vista (trae `cuotas_inscripcion`), igual que la pantalla:
  // este endpoint decide QUÉ cuotas cierra, así que si su consulta no coincidiera con
  // la de la vista escribiría plata sobre un conjunto distinto del que la persona ve.
  // Los `update` de más abajo siguen apuntando a la tabla — en una vista no se escribe.
  // Se reconstruye entera en cada lote: un builder de supabase-js ya ejecutado no
  // se reutiliza para pedir el rango siguiente.
  const construirConsulta = () => {
    const base = supabase.from("cartera_preventiva_v").select("*");
    let query: typeof base = base.not("valor_pago", "is", null);

    // El filtro "Día del Cruce" de la pantalla manda. La vista siempre lo envía en el
    // cuerpo; hasta el 2026-08-03 este endpoint no lo leía y cerraba SIEMPRE lo de hoy,
    // así que querer cerrar lo del viernes respondía "0 cuotas" — que se lee como
    // confirmación, no como "no hice nada".
    // El `else` no es opcional: sin filtro puesto el botón tiene que seguir alcanzando
    // solo el día de hoy. Si cerrara todos los días, la rutina de cada mañana arrastraría
    // cuotas viejas sin que nadie lo pida.
    if (cruceFrom || cruceTo) {
      if (cruceFrom) query = query.gte("fecha_cruce", cruceFrom);
      if (cruceTo)   query = query.lte("fecha_cruce", cruceTo);
    } else {
      query = query.eq("fecha_cruce", hoy);
    }

    if (search) query = query.or(`cliente.ilike.%${search}%,cruce_access.ilike.%${search}%,codigo_transaccion_1.ilike.%${search}%,inscrip.ilike.%${search}%`);
    if (estado === "resuelta") query = query.not("fecha_pago", "is", null);
    else if (estado === "pendiente") query = query.is("fecha_pago", null);
    if (vencFrom) query = query.gte("fecha_vencimiento", vencFrom);
    if (vencTo)   query = query.lte("fecha_vencimiento", vencTo);
    if (pagoParcial) query = query.lt("diferencia", 0);
    if (medioPago) {
      query = medioPago.endsWith("%")
        ? query.ilike("medio_pago", medioPago)
        : query.eq("medio_pago", medioPago);
    }
    if (payFrom) query = query.gte("fecha_pago", payFrom);
    if (payTo)   query = query.lte("fecha_pago", payTo);
    // "Con notificación de pago de más": excluye 'FALTA DE PAGO', que es lo
    // contrario (la cuota original de un pago parcial con faltante >= $50k lleva
    // esa marca) y colaría aquí por ser una notificacion no nula.
    if (conNotificacion) query = query.not("notificacion", "is", null).neq("notificacion", "").neq("notificacion", "FALTA DE PAGO");
    if (wompiTipo === "automatico") query = query.eq("es_wompi_automatico", true);
    else if (wompiTipo === "manual") query = query.eq("es_wompi_automatico", false);
    // Ver comentario en GET /api/cartera-preventiva: cuenta cuotas, no renglones.
    if (multiCuota) query = query.gt("cuotas_inscripcion", 1);

    // Desempate obligatorio: sin una columna única al final del orden, el corte
    // entre lotes pierde filas en silencio — y acá una fila perdida es una cuota
    // que el cierre no alcanza, sin decirlo.
    return query.order("id", { ascending: true });
  };

  const filas: Fila[] = [];
  for (let from = 0; from < MAX_ROWS; from += BATCH) {
    const batchSize = Math.min(BATCH, MAX_ROWS - from);
    const { data, error } = await construirConsulta().range(from, from + batchSize - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    filas.push(...(data as Fila[]));
    if (data.length < batchSize) break;
  }

  // Filas que se saltan en silencio, para que darle dos veces no haga daño:
  // sin valor_pago (nada que copiar) y ya cerradas (pago_confirmado == valor_pago).
  const pendientes = filas.filter((f) => {
    if (f.valor_pago === null) return false;
    return num(f.pago_confirmado) !== num(f.valor_pago);
  });

  let cerradas = 0;
  const errores: string[] = [];

  // Una fila a la vez con valores distintos: no hay update masivo en PostgREST.
  // El volumen esperado es de decenas de cuotas por día.
  const CHUNK = 10;
  for (let i = 0; i < pendientes.length; i += CHUNK) {
    const lote = pendientes.slice(i, i + CHUNK);
    const results = await Promise.all(lote.map(async (f) => {
      const valorPago = num(f.valor_pago);
      // `pago` ACUMULA: se le quita lo que puso un cierre anterior y se le suma el
      // valor_pago de ahora. Reemplazarlo borraría el abono que traía el Excel y la
      // cuota volvería a mostrar deuda ya pagada.
      const nuevoPago = num(f.pago) - num(f.pago_confirmado) + valorPago;
      const { error: updErr } = await supabase
        .from("cartera_preventiva")
        .update({
          pago: String(nuevoPago),                       // columna de texto en el esquema real
          valor_a_cobrar: num(f.valor_cuota) - nuevoPago, // invariante, no se fuerza a 0
          pago_confirmado: valorPago,                     // cuánto de `pago` lo puso el cierre
        })
        .eq("llave", f.llave);
      return updErr ? `${f.llave}: ${updErr.message}` : null;
    }));
    for (const r of results) {
      if (r) errores.push(r); else cerradas++;
    }
  }

  await logAudit({
    user_email: user.email ?? "unknown",
    action: "cerrar_cartera_dia",
    filters: { dia: hoy, cruceFrom, cruceTo, search, estado, vencFrom, vencTo, pagoParcial, medioPago, payFrom, payTo, conNotificacion, wompiTipo, multiCuota, view: "cartera_preventiva" },
    result_count: cerradas,
  });

  return NextResponse.json({
    cerradas,
    saltadas: filas.length - pendientes.length,
    alcanzadas: filas.length,
    errores: errores.slice(0, 5),
  });
}
