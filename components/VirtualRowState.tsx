"use client";
import { createContext, useCallback, useContext, useState, useSyncExternalStore, type SetStateAction } from "react";
import { createVirtualRowState } from "@/lib/virtual-row-state";

export const VirtualRowStateContext = createContext<ReturnType<typeof createVirtualRowState> | null>(null);

export function useVirtualRowToggle(key: string, initial = false) {
  const retained = useContext(VirtualRowStateContext);
  const [local] = useState(createVirtualRowState);
  const store = retained ?? local;
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [key, store]);
  const snapshot = useCallback(() => store.get(key, initial), [key, initial, store]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setValue = useCallback((next: SetStateAction<boolean>) => {
    store.set(key, typeof next === "function" ? next(store.get(key, initial)) : next);
  }, [key, initial, store]);
  return [value, setValue] as const;
}
