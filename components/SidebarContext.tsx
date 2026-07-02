"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

const EXPANDED_WIDTH = 224;
const COLLAPSED_WIDTH = 40;

type SidebarContextValue = {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  width: number;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <SidebarContext.Provider
      value={{
        collapsed,
        setCollapsed,
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
