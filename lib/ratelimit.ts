// Rate limiting por IP — ventana deslizante simple
const store = new Map<string, { count: number; reset: number }>();

export function rateLimit(ip: string, limit = 60, windowMs = 60_000): { ok: boolean; remaining: number } {
  const now  = Date.now();
  const entry = store.get(ip);

  if (!entry || now > entry.reset) {
    store.set(ip, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }

  if (entry.count >= limit) {
    return { ok: false, remaining: 0 };
  }

  entry.count++;
  return { ok: true, remaining: limit - entry.count };
}

// Limpiar entradas expiradas cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.reset) store.delete(key);
  }
}, 300_000);
