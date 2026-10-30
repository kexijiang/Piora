import type { UiExpression, UiSurface, UiValue } from "./protocol";
import type { UiActionDeclaration } from "./action-contract";

/** Authoring and persisted surface versions deliberately have separate lifecycles. */
export const UI_PLAN_VERSION = 1 as const;
export const UI_PLAN_COMPILER_VERSION = "1.0.0";
export const UI_PLAN_LIMITS = Object.freeze({
  characters: 64_000, jsonDepth: 8, jsonValues: 20_000,
  inputs: 64, derived: 256, views: 64, surfaceNodes: 64,
  expressionNodes: 4096, expressionDepth: 12, surfaceCharacters: 64_000,
});

export type UiPlanAtom = { literal: UiValue } | { input: string } | { derived: string };
export type UiPlanValueType = "number" | "string" | "boolean";
export type UiPlanOperation = Extract<UiExpression, { op: string }>["op"];
interface InputBase { id: string; label: string; unit?: string }
export type UiPlanInput =
  | (InputBase & { valueType: "number"; value: number; min?: number; max?: number; step?: number; presentation?: "number" | "slider" })
  | (InputBase & { valueType: "string"; value: string; options: string[] })
  | (InputBase & { valueType: "boolean"; value: boolean });
export interface UiPlanDerived { id: string; op: UiPlanOperation; args: UiPlanAtom[] }
export type UiPlanView =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "metric"; label: string; value: UiPlanAtom; unit?: string }
  | { id: string; kind: "table"; columns: string[]; rows: UiPlanAtom[][] }
  | { id: string; kind: "barChart"; labels: string[]; values: UiPlanAtom[] };
export interface UiPlanV1 {
  planVersion: 1; id: string; title: string;
  inputs: UiPlanInput[]; derived: UiPlanDerived[]; views: UiPlanView[];
}
export type UiPlanErrorCode =
  | "PLAN_SHAPE" | "PLAN_VERSION" | "PLAN_LIMIT" | "PLAN_ID" | "PLAN_RANGE"
  | "PLAN_REFERENCE" | "PLAN_CYCLE" | "PLAN_TYPE" | "PLAN_ARITY"
  | "PLAN_COMPLEXITY" | "PLAN_DEFAULT_EVALUATION" | "PLAN_SURFACE";
export interface UiPlanDiagnostic {
  code: UiPlanErrorCode;
  /** Structural index path only; never includes model-provided identifiers or values. */
  path: string;
  expected: string;
  repairable: boolean;
}
export class UiPlanError extends Error {
  readonly diagnostic: UiPlanDiagnostic;
  constructor(code: UiPlanErrorCode, path: string, expected: string, repairable = true) {
    super(`${code} at ${path}: ${expected}`);
    this.name = "UiPlanError";
    this.diagnostic = Object.freeze({ code, path, expected, repairable });
  }
}
export interface CompiledUiPlan {
  planVersion: 1;
  compilerVersion: string;
  surface: UiSurface;
  actions?: UiActionDeclaration;
  /** Units are semantic/display metadata, never automatic conversion or rounding rules. */
  inputSemantics: Array<{ id: string; valueType: UiPlanValueType; unit?: string; options?: string[] }>;
  cost: { expressionNodes: number; expressionDepth: number; surfaceCharacters: number };
}
