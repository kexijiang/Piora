"use client";

import { useMemo } from "react";
import { SurfaceActions, type SurfaceActionStore } from "../intelligent-ui/SurfaceActions";
import type { MiniAppStateClient, MiniAppClientView } from "../../lib/mini-app/client-state";
import { refreshMiniAppClients } from "../../lib/mini-app/client-cache";

function actionStore(client: MiniAppStateClient): SurfaceActionStore {
    let previous: MiniAppClientView | undefined, snapshot: ReturnType<SurfaceActionStore["getSnapshot"]>;
    return { sessionId: client.sessionId, toolCallId: client.toolCallId, subscribe: client.subscribe, getSnapshot: () => {
      const view = client.getSnapshot();
      if (view !== previous) {
        previous = view;
        snapshot = { revision: view.output?.stateRevision ?? 0, status: view.status,
          hasPendingDraft: view.needsRecovery || !view.output?.writable || view.status !== "saved",
          surface: { nodes: view.output?.plan.inputs ?? [] } };
      }
      return snapshot;
    } } satisfies SurfaceActionStore;
}

export default function MiniAppActions({ client, english }: { client: MiniAppStateClient; english: boolean }) {
  const store = useMemo(() => actionStore(client), [client]);
  return <SurfaceActions store={store} locale={english ? "en" : "zh-CN"} kind="mini-app" refreshResults={refreshMiniAppClients} />;
}
