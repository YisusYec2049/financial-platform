"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/SidebarContext";

const NAV_ITEMS = [
  {
    href: "/",
    label: "Consolidado",
    tileClass: "bg-amber-500",
    viewBox: "0 0 24 24",
    icon: (
      <path d="M5.625 3.75a2.625 2.625 0 100 5.25h12.75a2.625 2.625 0 000-5.25H5.625zM3.75 11.25a.75.75 0 000 1.5h16.5a.75.75 0 000-1.5H3.75zM3 15.75a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75zM3.75 18.75a.75.75 0 000 1.5h16.5a.75.75 0 000-1.5H3.75z" />
    ),
  },
  {
    href: "/cruce",
    label: "Cruce de Cartera",
    tileClass: "bg-emerald-500",
    viewBox: "0 0 20 20",
    icon: (
      <path d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" />
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
      className={`shrink-0 sticky top-0 h-screen bg-[#f6f6f8] border-r border-black/[0.06] flex flex-col overflow-hidden transition-all duration-300 ease-in-out ${
        collapsed ? "w-14" : "w-56"
      }`}
    >
      <div className="px-3 py-4 flex items-center gap-2.5">
        <div className="shrink-0 w-8 h-8 rounded-lg bg-brand-600 shadow-sm flex items-center justify-center transition-transform duration-300 ease-(--ease-spring) hover:scale-110 hover:rotate-3">
          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18.375 2.25c-1.035 0-1.875.84-1.875 1.875v15.75c0 1.035.84 1.875 1.875 1.875h.75c1.035 0 1.875-.84 1.875-1.875V4.125c0-1.036-.84-1.875-1.875-1.875h-.75zM9.75 8.625c0-1.036.84-1.875 1.875-1.875h.75c1.035 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-.75a1.875 1.875 0 01-1.875-1.875V8.625zM3 13.125c0-1.036.84-1.875 1.875-1.875h.75c1.036 0 1.875.84 1.875 1.875v6.75c0 1.035-.84 1.875-1.875 1.875h-.75A1.875 1.875 0 013 19.875v-6.75z" />
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
              className={`group flex items-center rounded-lg text-sm font-medium whitespace-nowrap transition-all duration-200 ease-(--ease-spring) active:scale-[0.97] ${
                collapsed ? "justify-center gap-0 px-0 py-2" : "gap-2.5 px-2 py-2"
              } ${active ? "bg-brand-600 text-white shadow-sm" : "text-gray-600 hover:bg-black/[0.04]"}`}
            >
              <span
                className={`shrink-0 w-6 h-6 rounded-md ${item.tileClass} shadow-sm ring-1 ring-inset ring-white/20 flex items-center justify-center transition-transform duration-200 ease-(--ease-spring) group-hover:scale-110`}
              >
                <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox={item.viewBox}>
                  {item.icon}
                </svg>
              </span>
              <span
                className={`overflow-hidden transition-all duration-200 ${
                  collapsed ? "opacity-0 duration-100 w-0" : "opacity-100 delay-150 w-auto"
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
