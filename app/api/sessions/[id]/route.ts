import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readLatestSessionSystemPromptBinding } from "@/lib/session-system-prompt";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  listAllSessions,
} from "@/lib/session-reader";
import { getRpcSession, stopRpcSessionsForFileMutation } from "@/lib/rpc-manager";
import { readPendingSessionModel } from "@/lib/session-model-selection";
import { acquireSessionMutation, assertSessionNotMutating, collectSessionSubtree } from "@/lib/session-mutation";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { isMissingSessionFileError, resolveSessionDetailSource } from "@/lib/session-detail-source";
import { purgeExpiredTrash, trashSession } from "@/lib/session-trash";

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;
const MAX_SESSION_RESPONSE_CACHE_BYTES = 48 * 1024 * 1024;

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, branch points, and leaves while contracting single-child chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain.
 */
function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[] }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[]): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[] }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

async function buildSessionResponse(
  id: string,
  filePath: string,
  modified: string,
  deferThinking: boolean,
  deferToolResultImages: boolean,
  includeTree: boolean,
  manager?: SessionManager,
) {
  const sm = manager ?? SessionManager.open(filePath);
  const entries = sm.getEntries() as never;
  const leafId = sm.getLeafId();
  const tree = includeTree ? projectTreeForResponse(sm.getTree()) : [];
  const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });
  const selectedModel = readPendingSessionModel(id);
  if (selectedModel && !getRpcSession(id)?.isRunning()) context.model = { provider: selectedModel.provider, modelId: selectedModel.modelId };
  const header = sm.getHeader();
  const parentSessionId = header?.parentSession
    ? await resolveSessionIdByPath(header.parentSession)
    : undefined;
  const info = header ? {
    path: filePath,
    id: header.id,
    cwd: header.cwd ?? "",
    name: sm.getSessionName(),
    created: header.timestamp,
    modified,
    messageCount: context.messages.length,
    firstMessage: context.messages.find((m) => m.role === "user")
      ? (() => {
          const msg = context.messages.find((m) => m.role === "user")!;
          const c = (msg as { content: unknown }).content;
          return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "");
        })()
      : "",
    parentSessionId,
  } : null;

  return {
    sessionId: id,
    // A live manager can contain buffered messages before its first disk flush.
    // Only a manager opened from the file supplies durable delivery receipts.
    persistedPromptIds: manager ? [] : sm.getEntries().flatMap((entry) => {
      const message = entry.type === "message" ? entry.message as { role: string; clientPromptId?: string } : null;
      return message?.role === "user" && message.clientPromptId ? [message.clientPromptId] : [];
    }),
    filePath,
    info,
    leafId,
    tree,
    context,
    systemPromptBinding: readLatestSessionSystemPromptBinding(sm.getEntries()),
  };
}

type SessionRoutePayload = Awaited<ReturnType<typeof buildSessionResponse>>;
type SerializedSessionResponse = {
  body: string;
  etag: string;
  byteLength: number;
};
type SessionResponseCacheEntry = {
  signature: string;
  lastAccessedAt: number;
  byteLength: number;
  promise: Promise<SerializedSessionResponse>;
};

declare global {
  var __pioraSessionResponseCache: Map<string, SessionResponseCacheEntry> | undefined;
}

function sessionResponseCache(): Map<string, SessionResponseCacheEntry> {
  if (!globalThis.__pioraSessionResponseCache) globalThis.__pioraSessionResponseCache = new Map();
  return globalThis.__pioraSessionResponseCache;
}

function sessionResponseEtag(id: string, signature: string, projection: string): string {
  const digest = createHash("sha256")
    .update(`${id}\0${signature}\0${projection}`)
    .digest("base64url");
  return `"${digest}"`;
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  const normalizedEtag = etag.replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const normalizedCandidate = candidate.trim();
    return normalizedCandidate === "*" || normalizedCandidate.replace(/^W\//, "") === normalizedEtag;
  });
}

function serializeSessionResponse(payload: SessionRoutePayload, etag: string): SerializedSessionResponse {
  const body = JSON.stringify(payload);
  return { body, etag, byteLength: Buffer.byteLength(body, "utf8") };
}

function pruneSessionResponseCache(cache: Map<string, SessionResponseCacheEntry>): void {
  let cachedBytes = 0;
  for (const entry of cache.values()) cachedBytes += entry.byteLength;

  while (cachedBytes > MAX_SESSION_RESPONSE_CACHE_BYTES) {
    let oldest: [string, SessionResponseCacheEntry] | null = null;
    for (const candidate of cache) {
      if (!oldest || candidate[1].lastAccessedAt < oldest[1].lastAccessedAt) oldest = candidate;
    }
    if (!oldest) break;
    cache.delete(oldest[0]);
    cachedBytes -= oldest[1].byteLength;
  }
}

async function loadCachedSessionResponse(
  id: string,
  filePath: string,
  deferThinking: boolean,
  deferToolResultImages: boolean,
  includeTree: boolean,
  ifNoneMatch: string | null,
): Promise<SerializedSessionResponse | { body: null; etag: string }> {
  const fileState = statSync(filePath);
  const signature = `${fileState.size}:${fileState.mtimeMs}:${readPendingSessionModel(id)?.revision ?? ""}:${getRpcSession(id)?.isRunning() ?? false}`;
  const projection = `${deferThinking ? "thinking-deferred" : "thinking-full"}\0${deferToolResultImages ? "media-deferred" : "media-full"}\0${includeTree ? "tree" : "no-tree"}`;
  const etag = sessionResponseEtag(id, signature, projection);
  if (matchesEtag(ifNoneMatch, etag)) return { body: null, etag };

  // Only retain the lightweight chat-switch projection. Full-history callers
  // may include large base64 media and should not occupy the in-process LRU.
  if (!deferThinking || !deferToolResultImages) {
    const payload = await buildSessionResponse(
      id,
      filePath,
      fileState.mtime.toISOString(),
      deferThinking,
      deferToolResultImages,
      includeTree,
    );
    return serializeSessionResponse(payload, etag);
  }
  const cacheKey = `${filePath}\0${projection}`;
  const cache = sessionResponseCache();
  const existing = cache.get(cacheKey);
  if (existing?.signature === signature) {
    existing.lastAccessedAt = Date.now();
    return existing.promise;
  }

  const promise = buildSessionResponse(
    id,
    filePath,
    fileState.mtime.toISOString(),
    deferThinking,
    deferToolResultImages,
    includeTree,
  ).then((payload) => {
    const serialized = serializeSessionResponse(payload, etag);
    const current = cache.get(cacheKey);
    if (current?.promise === promise) {
      current.byteLength = serialized.byteLength;
      pruneSessionResponseCache(cache);
    }
    return serialized;
  });
  const entry: SessionResponseCacheEntry = {
    signature,
    lastAccessedAt: Date.now(),
    byteLength: 0,
    promise,
  };
  cache.set(cacheKey, entry);

  try {
    return await entry.promise;
  } catch (error) {
    if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
    throw error;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const source = await resolveSessionDetailSource(id, {
      getLiveSession: getRpcSession,
      resolveSessionPath,
      sessionFileExists: existsSync,
    });
    if (!source) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const includeTree = searchParams.has("includeTree");
    if (source.kind === "memory") {
      const payload = await buildSessionResponse(
        id,
        source.filePath,
        source.manager.getHeader()?.timestamp ?? new Date().toISOString(),
        deferThinking,
        deferToolResultImages,
        includeTree,
        source.manager,
      );
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    let response: Awaited<ReturnType<typeof loadCachedSessionResponse>>;
    try {
      response = await loadCachedSessionResponse(
        id,
        source.filePath,
        deferThinking,
        deferToolResultImages,
        includeTree,
        req.headers.get("if-none-match"),
      );
    } catch (error) {
      if (!isMissingSessionFileError(error)) throw error;
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const headers = {
      "cache-control": "private, no-cache",
      "content-type": "application/json; charset=utf-8",
      etag: response.etag,
    };
    if (response.body === null) return new Response(null, { status: 304, headers });
    return new Response(response.body, { status: 200, headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const trimmedName = name.trim();
    assertSessionNotMutating(id);
    const liveSession = getRpcSession(id);
    if (liveSession?.isAlive()) liveSession.setSessionName(trimmedName);
    else SessionManager.open(filePath).appendSessionInfo(trimmedName);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
// Preserve the whole subtree for exact recovery, including after the undo toast.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    let expectedIds: Set<string> | undefined;
    if (req.body) {
      const body = await parseJsonWithinLimit(req, 512 * 1024) as { expectedSessionIds?: unknown };
      if (!Array.isArray(body?.expectedSessionIds) || !body.expectedSessionIds.every((value) => typeof value === "string")) {
        return NextResponse.json({ error: "Expected conversation scope" }, { status: 400 });
      }
      expectedIds = new Set(body.expectedSessionIds);
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Collect the whole subtree (this session + every descendant that points
    // at a member via parentSessionId) so restore is an exact move-back.
    const all = await listAllSessions();
    let subtree = collectSessionSubtree(all, id);
    const ids = subtree.length ? subtree.map((session) => session.id) : [id];
    if (expectedIds && ids.some((sessionId) => !expectedIds.has(sessionId))) {
      return NextResponse.json({ error: "Conversation branches changed. Review the affected conversations and try again." }, { status: 409 });
    }
    const releases = [acquireSessionMutation(ids)];
    try {
      let pendingIds = [...ids];
      while (pendingIds.length) {
        await stopRpcSessionsForFileMutation(pendingIds);
        // A fork admitted before our locks may have finished during the drain.
        // Include its descendants before moving anything, and lock each new writer.
        subtree = collectSessionSubtree(await listAllSessions(), id);
        const locked = new Set(ids);
        pendingIds = subtree.map((session) => session.id).filter((sessionId) => !locked.has(sessionId));
        if (expectedIds && pendingIds.some((sessionId) => !expectedIds.has(sessionId))) {
          return NextResponse.json({ error: "Conversation branches changed. Review the affected conversations and try again." }, { status: 409 });
        }
        if (pendingIds.length) {
          releases.push(acquireSessionMutation(pendingIds));
          ids.push(...pendingIds);
        }
      }
      const subtreePaths = subtree.length ? subtree.map((session) => session.path) : [filePath];
      purgeExpiredTrash();
      const root = subtree.find((session) => session.id === id);
      trashSession(id, subtreePaths, { title: root?.name || root?.firstMessage?.slice(0, 120), cwd: root?.cwd });
      for (const sessionId of ids) invalidateSessionPathCache(sessionId);
      invalidateSessionListCache();
      return NextResponse.json({ ok: true, trashedCount: subtreePaths.length, sessionIds: ids });
    } finally {
      for (const release of releases.reverse()) release();
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
