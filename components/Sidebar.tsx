"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/SidebarContext";

const NAV_ITEMS = [
  {
    href: "/",
    label: "Consolidado",
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
      />
    ),
  },
  {
    href: "/cruce",
    label: "Cruce de Cartera",
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4"
      />
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { collapsed, setCollapsed } = useSidebar();

  return (
    <aside
      onMouseEnter={() => setCollapsed(false)}
      onMouseLeave={() => setCollapsed(true)}
      className={`shrink-0 bg-[#f6f6f8] border-r border-black/[0.06] min-h-screen flex flex-col overflow-hidden transition-all duration-300 ease-in-out ${
        collapsed ? "w-14" : "w-56"
      }`}
    >
      <div className="px-3 py-4 flex items-center gap-2.5">
        <div className="shrink-0 w-8 h-8 rounded-lg bg-brand-600 shadow-sm flex items-center justify-center">
          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .672-3 1.5S10.343 11 12 11s3 .672 3 1.5-1.343 1.5-3 1.5m0-6V6m0 9v1.5M12 6v0a3 3 0 013 3M12 18a3 3 0 01-3-3" />
          </svg>
        </div>
        <h2
          className={`text-sm font-semibold text-gray-800 whitespace-nowrap transition-opacity duration-200 ${
            collapsed ? "opacity-0 duration-100" : "opacity-100 delay-150"
          }`}
        >
          Plataforma Financiera
        </h2>
      </div>

      <nav className="flex-1 px-2.5 py-2 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active ? "bg-brand-600 text-white shadow-sm" : "text-gray-600 hover:bg-black/[0.04]"
              }`}
            >
              <svg
                className={`w-4 h-4 shrink-0 ${active ? "text-white" : "text-gray-500"}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {item.icon}
              </svg>
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
