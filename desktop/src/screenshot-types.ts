import type { CaptureDisplay, CapturePlan, CaptureRect } from "./screenshot-geometry.js";

export interface ScreenshotFrame extends CaptureDisplay {
  dipBounds: CaptureRect;
  dataUrl: string;
}

export interface ScreenshotWindowState {
  captureId: string;
  displayId: string;
  frame: ScreenshotFrame;
  targetDraftKey: string | null;
  update: ScreenshotWindowUpdate | null;
}

export type ScreenshotWindowUpdate =
  | { phase: "selection"; bounds: CaptureRect | null }
  | { phase: "editing"; selection: CaptureRect; plan: CapturePlan; frames: ScreenshotFrame[]; targetDraftKey: string | null }
  | { phase: "error"; message: string };

export type ScreenshotOutputAction = "copy" | "save" | "attach";
export type ScreenshotOutputResult =
  | { status: "done" }
  | { status: "cancelled" }
  | { status: "pending" }
  | { status: "error"; message: string };

export interface PendingScreenshotAttachment {
  captureId: string;
  targetDraftKey: string;
  mimeType: "image/png";
  data: string;
}
