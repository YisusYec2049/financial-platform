"use client";

import Sidebar from "@/components/Sidebar";
import { SidebarProvider } from "@/components/SidebarContext";
import { usePathname } from "next/navigation";

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <SidebarProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 min-w-0 min-h-screen bg-[#f2f2f4]">
          <div key={pathname} className="animate-fade-in">{children}</div>
        </main>
      </div>
    </SidebarProvider>
  );
}
