"use client";

import { lazy } from "react";

/** Static imports are forbidden here: disabled features must not load their code. */
const renderers = {
  "intelligent-ui": {
    Surface: lazy(() => import("./intelligent-ui/IntelligentUiSurface")),
    Preview: lazy(() => import("./intelligent-ui/IntelligentUiPreview")),
  },
  "mini-app": {
    Surface: lazy(() => import("./mini-app/MiniAppSurface")),
    Preview: lazy(() => import("./mini-app/MiniAppPreview")),
  },
};

export function answerOutputRenderer(kind: string) {
  return renderers[kind as keyof typeof renderers];
}
