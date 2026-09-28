import { NextResponse } from "next/server";
import { InvalidJsonBodyError, JsonBodyTooLargeError } from "@/lib/bounded-json";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isValidDesktopToken, PI_DESKTOP_TOKEN_HEADER } from "@/lib/web-auth";
import { asHarmonyError, HarmonyError, type HarmonyErrorCode } from "@/lib/harmony/errors";
import type { HarmonyManagerEvent, HarmonyManagerState } from "@/lib/harmony/types";

const ERROR_STATUS: Partial<Record<HarmonyErrorCode, number>> = {
  HDC_NOT_FOUND: 503,
  HDC_INVALID: 400,
  DEVICE_NOT_FOUND: 404,
  DEVICE_OFFLINE: 409,
  LEASE_REQUIRED: 409,
  LEASE_CONFLICT: 409,
  LEASE_EXPIRED: 409,
  STALE_SNAPSHOT: 409,
  OBSERVATION_UNAVAILABLE: 409,
  SCREEN_LOCKED: 409,
  DEVICE_BUSY: 409,
  CAPABILITY_UNAVAILABLE: 501,
  UI_TARGET_NOT_FOUND: 404,
  UI_TARGET_AMBIGUOUS: 409,
  AUTOMATION_DRIVER_UNAVAILABLE: 503,
  AUTOMATION_DRIVER_FAILED: 502,
  SCENARIO_FAILED: 409,
  COMMAND_TIMEOUT: 504,
  COMMAND_ABORTED: 499,
  COMMAND_OUTPUT_LIMIT: 502,
  COMMAND_FAILED: 502,
  INVALID_ARGUMENT: 400,
  INVALID_RESPONSE: 502,
  INTERNAL_ERROR: 500,
};

export function requireHarmonyDesktopAccess(request: Request): NextResponse | null {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: { code: "UNTRUSTED_REQUEST", message: "Untrusted API request" } }, { status: 403 });
  }
  if (!isValidDesktopToken(request.headers.get(PI_DESKTOP_TOKEN_HEADER))) {
    return NextResponse.json({ error: { code: "DESKTOP_AUTH_REQUIRED", message: "Desktop authentication required" } }, { status: 403 });
  }
  return null;
}

export function requireHarmonyAccess(request: Request): NextResponse | null {
  return requireHarmonyDesktopAccess(request);
}

export function harmonyErrorResponse(error: unknown): NextResponse {
  if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
  if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
  const harmonyError = asHarmonyError(error);
  return NextResponse.json(
    { error: harmonyError.toJSON() },
    { status: ERROR_STATUS[harmonyError.code] ?? 500, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function noStoreJson(value: unknown, init?: { status?: number }): NextResponse {
  return NextResponse.json(value, {
    status: init?.status ?? 200,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** State is metadata-only. Lease bearer tokens never leave the lease route. */
export function publicManagerState(state: HarmonyManagerState): Omit<HarmonyManagerState, "leases"> & {
  leases: Array<Omit<HarmonyManagerState["leases"][number], "token">>;
} {
  return {
    ...state,
    leases: state.leases.map(({ token, ...lease }) => {
      void token;
      return lease;
    }),
  };
}

/** SSE deliberately excludes screenshots, UI trees, input text, and bearer tokens. */
export function publicManagerEvent(event: HarmonyManagerEvent): unknown {
  if (event.type === "state") return { ...event, state: publicManagerState(event.state) };
  if (event.type === "lease_acquired") {
    const { token, ...lease } = event.lease;
    void token;
    return { ...event, lease };
  }
  return event;
}

export function requiredQuery(request: Request, name: string): string {
  const value = new URL(request.url).searchParams.get(name)?.trim();
  if (!value) throw new HarmonyError("INVALID_ARGUMENT", `Missing ${name}`);
  return value;
}
