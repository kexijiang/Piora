"use client";

import { createContext } from "react";

/** Host branch identity invalidates optional output views without exposing chat internals. */
export const AnswerOutputScope = createContext<string | null>(null);
