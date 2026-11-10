// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export interface CreateAgentSessionRequest {
  cwd: string;
  type: "ensure_session";
  capabilitySelection?: {
    preset: "chat" | "coding" | "research" | "device" | "custom";
    enabledCapabilityIds?: string[];
  };
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  systemPromptSelection?: import("./system-prompt-types").SystemPromptSelection;
}

export interface CreateAgentSessionResponse {
  sessionId: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  capabilities?: import("./session-capabilities").SessionCapabilitiesState;
}

const SESSION_CREATION_RETRY_DELAY_MS = 180;

/**
 * Creates the lazy runtime for a new conversation. The server marks only
 * transient filesystem/lock failures as retryable; if one happens after the
 * wrapper starts, the creation boundary destroys that wrapper before replying.
 */
export async function createAgentSessionRequest(
  request: CreateAgentSessionRequest,
): Promise<CreateAgentSessionResponse> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = (await res.json().catch(() => ({}))) as CreateAgentSessionResponse & {
      error?: string;
      code?: string;
    };
    if (res.ok && !body.error) return body;

    const error = new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
    );
    if (error.code !== "SESSION_CREATION_RETRYABLE" || attempt > 0) throw error;
    await new Promise((resolve) => setTimeout(resolve, SESSION_CREATION_RETRY_DELAY_MS));
  }
  throw new AgentCommandError("Session creation failed", 500, "SESSION_CREATION_FAILED");
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    controller.abort(new AgentCommandError("Command acknowledgement timed out", 0, "COMMAND_TIMEOUT"));
  }, options.timeoutMs);
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    const body = (await res.json().catch((error) => {
      // An aborted response body is not a successful acknowledgement.
      controller.signal.throwIfAborted();
      if (error instanceof SyntaxError && !res.ok) return {};
      throw error;
    })) as {
      success?: boolean;
      data?: T;
      error?: string;
      code?: string;
    };
    controller.signal.throwIfAborted();
    if (!res.ok || body.error) {
      throw new AgentCommandError(body.error ?? `HTTP ${res.status}`, res.status, body.code);
    }
    return body.data as T;
  } finally {
    clearTimeout(timeout);
  }
}
