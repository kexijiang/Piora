"use client";

import { createContext } from "react";
import type { AnswerOutputPreview } from "@/lib/answer-output-preview";

/** Host branch identity invalidates optional output views without exposing chat internals. */
export const AnswerOutputScope = createContext<string | null>(null);
/** Transient output stays outside the durable message/tool-result collections. */
export const AnswerOutputPreviews = createContext<ReadonlyMap<string, AnswerOutputPreview>>(new Map());
