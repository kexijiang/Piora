"use client";

import { createContext, useContext } from "react";

export const CompactProcessContext = createContext(false);
export const RevealProcessCommandContext = createContext<string | null>(null);
export function useCompactProcess() { return useContext(CompactProcessContext); }
