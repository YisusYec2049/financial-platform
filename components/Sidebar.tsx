"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/SidebarContext";

const NAV_ITEMS = [
  { href: "/", label: "Consolidado" },
  { href: "/cruce", label: "Cruce de Cartera" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { collapsed, setCollapsed } = useSidebar();

  return (
    <aside
      onMouseEnter={() => setCollapsed(false)}
      onMouseLeave={() => setCollapsed(true)}
      className={`shrink-0 bg-brand-800 min-h-screen flex flex-col overflow-hidden transition-all duration-300 ease-in-out ${
        collapsed ? "w-10" : "w-56"
      }`}
    >
      <div className="px-3 py-4 border-b border-brand-700 flex items-center gap-2">
        <svg className="w-4 h-4 shrink-0 text-blue-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
        <h2
          className={`text-sm font-semibold text-white whitespace-nowrap transition-opacity duration-200 ${
            collapsed ? "opacity-0 duration-100" : "opacity-100 delay-150"
          }`}
        >
          Plataforma Financiera
        </h2>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active ? "bg-white text-brand-700 shadow-sm" : "text-blue-100 hover:text-white hover:bg-brand-700"
              }`}
            >
              <span
                className={`transition-opacity duration-200 ${
                  collapsed ? "opacity-0 duration-100" : "opacity-100 delay-150"
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
