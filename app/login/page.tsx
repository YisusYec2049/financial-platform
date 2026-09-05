"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

/* Ojo abierto / cerrado del botón de mostrar contraseña (estilo trazo, como los íconos de la vista) */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <path d="M2.5 9.5c2.4 3.4 5.6 5.1 9.5 5.1s7.1-1.7 9.5-5.1" />
          <path d="M4.4 13.1 2.8 15.6" />
          <path d="M8.2 14.9 7.4 17.7" />
          <path d="M15.8 14.9l.8 2.8" />
          <path d="m19.6 13.1 1.6 2.5" />
        </>
      ) : (
        <>
          <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError("Correo o contraseña incorrectos.");
      setLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-[#f2f2f4] flex items-center justify-center px-4">
      <div className="animate-pop-in bg-white rounded-2xl shadow-[0_1px_1px_rgba(0,0,0,0.03),0_16px_40px_-16px_rgba(0,0,0,0.18)] border border-black/[0.06] w-full max-w-sm p-8">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-2xl bg-brand-600 shadow-sm flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.375 2.25c-1.035 0-1.875.84-1.875 1.875v15.75c0 1.035.84 1.875 1.875 1.875h.75c1.035 0 1.875-.84 1.875-1.875V4.125c0-1.036-.84-1.875-1.875-1.875h-.75zM9.75 8.625c0-1.036.84-1.875 1.875-1.875h.75c1.035 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-.75a1.875 1.875 0 01-1.875-1.875V8.625zM3 13.125c0-1.036.84-1.875 1.875-1.875h.75c1.036 0 1.875.84 1.875 1.875v6.75c0 1.035-.84 1.875-1.875 1.875h-.75A1.875 1.875 0 013 19.875v-6.75z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Iniciar sesión</h1>
          <p className="text-sm text-gray-500 mt-1">Acceso exclusivo para miembros del equipo</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Correo electrónico
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-black/10 bg-gray-50/60 rounded-xl px-3.5 py-2 text-sm text-gray-900 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors"
              placeholder="tu@empresa.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Contraseña
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-black/10 bg-gray-50/60 rounded-xl pl-3.5 pr-11 py-2 text-sm text-gray-900 focus:outline-none focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:border-brand-400 transition-colors"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                title={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-brand-600 hover:text-brand-700 rounded-r-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 transition-colors"
              >
                <EyeIcon off={showPassword} />
              </button>
            </div>
          </div>

          {error && (
            <p className="animate-shake text-sm text-red-600 bg-red-50 border border-red-200/80 rounded-xl px-3.5 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 text-white text-sm font-semibold py-2.5 rounded-full shadow-sm hover:bg-brand-700 hover:brightness-105 active:scale-[0.97] transition-all duration-200 ease-(--ease-spring) disabled:opacity-50 disabled:active:scale-100"
          >
            {loading ? "Iniciando sesión..." : "Iniciar sesión"}
          </button>
        </form>
      </div>
    </div>
  );
}
