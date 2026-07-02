"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

const EXPANDED_WIDTH = 224;
const COLLAPSED_WIDTH = 40;

type SidebarContextValue = {
  collapsed: boolean;
  toggle: () => void;
  width: number;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <SidebarContext.Provider
      value={{
        collapsed,
        toggle: () => setCollapsed((c) => !c),
        width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
  return ctx;
}
