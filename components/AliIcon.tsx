import type { CSSProperties, SVGProps } from "react";

/**
 * Line icon set in the Lucide style (24×24 grid, optically sized stroke, rounded caps),
 * matching the icon language used by Codex desktop.
 *
 * Path data follows the Lucide icon set (ISC License, https://lucide.dev)
 * or are hand-drawn equivalents with the same geometry. Filled accents
 * (ellipsis dots, palette dots) live in the `fill` array.
 */

interface IconDef {
  /** Stroke paths — inherit the svg stroke, fill is none. */
  stroke?: readonly string[];
  /** Filled paths — solid `currentColor`, no stroke. */
  fill?: readonly string[];
}

const ICONS = {
  "brain": { stroke: ["M12 6a3 3 0 0 0-5.8-1A4 4 0 0 0 4 12a4 4 0 0 0 2 7 3 3 0 0 0 6 0Z", "M12 6a3 3 0 0 1 5.8-1A4 4 0 0 1 20 12a4 4 0 0 1-2 7 3 3 0 0 1-6 0", "M8 8a3 3 0 0 1-2 3", "M16 8a3 3 0 0 0 2 3", "M8 16a3 3 0 0 0 4-3", "M16 16a3 3 0 0 1-4-3"] },
  "timer": { stroke: ["M9 2h6", "M12 6a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z", "M12 10v4", "m18 7 2-2"] },
  "heart": { stroke: ["M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"] },
  "bookmark": { stroke: ["M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z", "M9 7h6", "M9 11h4"] },
  "activity": { stroke: ["M22 12h-4l-3 9L9 3l-3 9H2"] },
  "alert": {
    stroke: ["M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z", "M12 9v4", "M12 17h.01"],
  },
  "appstore-add": {
    stroke: [
      "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
      "M17.5 16.5v3", "M16 18h3",
    ],
  },
  "arrowdown": { stroke: ["M12 5v14", "m19 12-7 7-7-7"] },
  "arrowleft": { stroke: ["m12 19-7-7 7-7", "M19 12H5"] },
  "arrowright": { stroke: ["M5 12h14", "m12 5 7 7-7 7"] },
  "external-link": { stroke: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"] },
  "arrowup": { stroke: ["m5 12 7-7 7 7", "M12 19V5"] },
  "archive": { stroke: ["M21 8v13H3V8", "M1 3h22v5H1z", "M10 12h4"] },
  "attachment": {
    stroke: ["m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"],
  },
  "bell": { stroke: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"] },
  "branches": {
    stroke: ["M6 3v12", "M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M6 18a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M18 9a9 9 0 0 1-9 9"],
  },
  "bug": {
    stroke: [
      "m8 2 1.88 1.88", "M14.12 3.88 16 2", "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1",
      "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6",
      "M12 20v-9", "M6.53 9C4.6 8.8 3 7.1 3 5", "M6 13H2", "M3 21c0-2.1 1.7-3.9 3.8-4",
      "M20.97 5c0 2.1-1.6 3.8-3.5 4", "M22 13h-4", "M17.2 17c2.1.1 3.8 1.9 3.8 4",
    ],
  },
  "build": {
    stroke: [
      "m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9",
      "m18 15 4-4",
      "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5",
    ],
  },
  "calendar": {
    stroke: ["M8 2v4", "M16 2v4", "M3 10h18", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"],
  },
  "chart-no-axes-column": { stroke: ["M5 21v-6", "M12 21V3", "M19 21V9"] },
  "check": { stroke: ["M20 6 9 17l-5-5"] },
  "chevron-right": { stroke: ["m9 18 6-6-6-6"] },
  "check-circle": {
    stroke: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "m9 12 2 2 4-4"],
  },
  "clear": {
    stroke: [
      "M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
      "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6",
    ],
  },
  "close": { stroke: ["M18 6 6 18", "m6 6 12 12"] },
  "code": { stroke: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"] },
  "collapse": { stroke: ["M4 14h6v6", "M20 10h-6V4", "M14 10l7-7", "M3 21l7-7"] },
  "comment": { stroke: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"] },
  "chat-bubble": { stroke: ["M12 3.84c4.92 0 8.88 3.54 8.88 7.92s-3.96 7.92-8.88 7.92a9.6 9.6 0 0 1-4.44-1.08l-3.36.96.78-3.18A7.38 7.38 0 0 1 3.12 11.76c0-4.38 3.96-7.92 8.88-7.92Z"] },
  "compose": {
    stroke: [
      "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
      "M18.38 2.62a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z",
    ],
  },
  "copy": {
    stroke: [
      "M8 8h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z",
      "M20 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2",
    ],
  },
  "database": {
    stroke: [
      "M12 2c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3z",
      "M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5",
      "M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3",
    ],
  },
  "delete": {
    stroke: [
      "M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
      "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6",
    ],
  },
  "diff": {
    stroke: [
      "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4",
      "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
      "M8 12h8", "M12 8v8",
    ],
  },
  "download": { stroke: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"] },
  "edit": { stroke: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"] },
  "ellipsis": {
    fill: [
      "M4.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z",
      "M10.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z",
      "M16.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z",
    ],
  },
  "enter": { stroke: ["m14 15-5 5-5-5", "M20 19h-6a5 5 0 0 1-5-5V3"] },
  "error": {
    stroke: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h.01"],
  },
  "expand": { stroke: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"] },
  "export": { stroke: ["M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8", "m16 6-4-4-4 4", "M12 2v13"] },
  "eye": { stroke: ["M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"] },
  "eye-close": {
    stroke: [
      "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94",
      "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19",
      "m1 1 22 22",
      "M9.88 9.88a3 3 0 1 0 4.24 4.24",
    ],
  },
  "file": { stroke: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"] },
  "file-add": {
    stroke: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M12 17v-6", "M15 14h-6"],
  },
  "file-search": {
    stroke: [
      "M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z",
      "M14 2v4a2 2 0 0 0 2 2h4",
      "M12.5 13.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
      "m15 16 3.5 3.5",
    ],
  },
  "filter": { stroke: ["M22 3H2l8 9.46V19l4 2v-8.54L22 3z"] },
  "folder": {
    stroke: ["M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"],
  },
  "folder-add": {
    stroke: [
      "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z",
      "M12 10v6", "M15 13H9",
    ],
  },
  "folder-open": {
    stroke: [
      "m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2",
    ],
  },
  "fork": {
    stroke: [
      "M12 18a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
      "M6 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
      "M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
      "M18 9v2a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V9",
      "M12 12v3",
    ],
  },
  "fullscreen": { stroke: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"] },
  "fullscreen-exit": { stroke: ["M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16h3a2 2 0 0 1 2 2v3", "M16 21v-3a2 2 0 0 1 2-2h3"] },
  "earth": {
    stroke: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
  },
  "home": {
    stroke: [
      "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",
      "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    ],
  },
  "import": { stroke: ["M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4", "m10 17 5-5-5-5", "M15 12H3"] },
  "info": { stroke: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"] },
  "key": {
    stroke: [
      "M21 2l-9.6 9.6",
      "M7.5 15.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z",
      "m15.5 7.5 3 3L22 7l-3-3",
    ],
  },
  "layout": { stroke: ["M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z", "M9 3v18"] },
  "link": {
    stroke: [
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ],
  },
  "lock": {
    stroke: [
      "M18 11V7a6 6 0 0 0-12 0v4",
      "M4 11h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
      "M12 15v2",
    ],
  },
  "logout": { stroke: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"] },
  "menu": { stroke: ["M4 6h16", "M4 12h16", "M4 18h16"] },
  "message": { stroke: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"] },
  "message-plus": { stroke: ["M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h6", "M16 3v6", "M13 6h6"] },
  "messages": {
    stroke: [
      "M21 15a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
      "M7 9h10",
      "M7 13h6",
    ],
  },
  "microphone": {
    stroke: [
      "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
      "M19 10v2a7 7 0 0 1-14 0v-2",
      "M12 19v3",
      "M8 22h8",
    ],
  },
  "minus": { stroke: ["M5 12h14"] },
  "notification": {
    stroke: [
      "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9",
      "M10.3 21a1.94 1.94 0 0 0 3.4 0",
      "M4 2C2.8 3.7 2 5.7 2 8",
      "M22 8c0-2.3-.8-4.3-2-6",
    ],
  },
  "pause": { stroke: ["M6.5 4h3v16h-3zM14.5 4h3v16h-3z"] },
  "package": {
    stroke: [
      "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
      "m3.3 7 8.7 5 8.7-5",
      "M12 22V12",
      "m7.5 4.27 9 5.15",
    ],
  },
  "play": { stroke: ["M5 3l14 9-14 9V3z"] },
  "plus": { stroke: ["M12 5v14", "M5 12h14"] },
  "project": { stroke: ["M3 3h18v18H3z", "M8 7v7", "M12 7v4", "M16 7v9"] },
  "pushpin": {
    stroke: [
      "M12 17v5",
      "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z",
    ],
  },
  "question": {
    stroke: [
      "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
      "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3",
      "M12 17h.01",
    ],
  },
  "reload": { stroke: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"] },
  "history": {
    stroke: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"],
  },
  "robot": {
    stroke: [
      "M12 3v3",
      "M9 3h6",
      "M7 7h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Z",
      "M4 12H2v4h2",
      "M20 12h2v4h-2",
      "M9 12h.01",
      "M15 12h.01",
      "M9 16h6",
    ],
  },
  "workflow": {
    stroke: [
      "M4 3h6v6H4z",
      "M14 3h6v6h-6z",
      "M14 15h6v6h-6z",
      "M10 6h4",
      "M17 9v6",
      "M10 6v12h4",
    ],
  },
  "sparkles": {
    stroke: [
      "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
      "M20 2v4", "M22 4h-4", "M4 18v2", "M5 19H3",
    ],
  },
  "save": { stroke: ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z", "M17 21v-8H7v8", "M7 3v5h8"] },
  "search": { stroke: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "m21 21-4.3-4.3"] },
  "send": { stroke: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"] },
  "setting": {
    stroke: [
      "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.73v.52a2 2 0 0 1-1 1.73l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.73v-.52a2 2 0 0 1 1-1.73l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    ],
  },
  "skin": {
    stroke: ["M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2.5a2 2 0 0 0-1.9 2.7c.3.9.4 1.7.4 2.3a2 2 0 0 1-2 2Z"],
    fill: [
      "M7.5 10.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
      "M12 7.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
      "M16.5 10.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
    ],
  },
  "shrink": { stroke: ["M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16h3a2 2 0 0 1 2 2v3", "M16 21v-3a2 2 0 0 1 2-2h3"] },
  "stop": { stroke: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"] },
  "sync": {
    stroke: [
      "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
      "M21 3v5h-5",
      "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
      "M8 16H3v5",
    ],
  },
  "time": { stroke: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"] },
  "translate": { stroke: ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"] },
  "unlock": {
    stroke: [
      "M18 11V7a6 6 0 0 0-12 0v4",
      "M4 11h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z",
      "M12 15v2",
    ],
  },
  "upload": { stroke: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"] },
  "user": { stroke: ["M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", "M12 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"] },
  "warning": {
    stroke: ["M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z", "M12 9v4", "M12 17h.01"],
  },
  "wrench": {
    stroke: [
      "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    ],
  },
  "api": { stroke: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"] },
  "desktop": { stroke: ["M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", "M8 21h8", "M12 17v4"] },
  "mobile": { stroke: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z", "M12 18h.01"] },
  "cloud": { stroke: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"] },
  "cloud-download": {
    stroke: [
      "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",
      "M12 13v8",
      "m8 17 4 4 4-4",
    ],
  },
  "cloud-upload": {
    stroke: [
      "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",
      "M12 12v8",
      "m8 16 4-4 4 4",
    ],
  },
  "solution": {
    stroke: [
      "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
      "M9 18h6",
      "M10 22h4",
    ],
  },
  "snippets": {
    stroke: [
      "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
      "M14 2v4a2 2 0 0 0 2 2h4",
      "m10 13-2 2 2 2",
      "m14 17 2-2-2-2",
    ],
  },
  "team": {
    stroke: [
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
      "M12 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
      "M22 21v-2a4 4 0 0 0-3-3.87",
      "M16 3.13a4 4 0 0 1 0 7.75",
    ],
  },
  "rocket": {
    stroke: [
      "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
      "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
      "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0",
      "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5",
    ],
  },
} as const;

export type AliIconName = keyof typeof ICONS;

type AliIconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: AliIconName;
  size?: number | string;
};

const SMALL_ICON_MAX_SIZE = 14;
const MEDIUM_ICON_MAX_SIZE = 18;

function getPixelIconSize(size: number | string): number | null {
  if (typeof size === "number") return Number.isFinite(size) && size > 0 ? size : null;
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/i.exec(size);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Optical stroke sizing for the shared 24x24 Lucide geometry.
 * Small controls stay crisp; larger icons become relatively lighter.
 */
export function getAdaptiveIconStrokeWidth(size: number | string): number {
  const pixelSize = getPixelIconSize(size);
  if (pixelSize === null || pixelSize <= SMALL_ICON_MAX_SIZE) return 2;
  if (pixelSize <= MEDIUM_ICON_MAX_SIZE) return 1.75;
  return 1.6;
}

/**
 * Renders a 24×24 line icon in the Lucide/Codex style with optical sizing.
 * Size follows surrounding text by default; pass values such as "1.4em"
 * when an icon needs greater optical weight.
 */
export function AliIcon({ name, size = "1em", strokeWidth, style, ...props }: AliIconProps) {
  const isLabelled = Boolean(props["aria-label"]);
  const resolvedStrokeWidth = strokeWidth ?? getAdaptiveIconStrokeWidth(size);
  const mergedStyle: CSSProperties = {
    display: "inline-block",
    flexShrink: 0,
    verticalAlign: "-0.125em",
    ...style,
  };
  // Keep the whole application renderable if a caller and the icon registry
  // briefly get out of sync during development hot reloads.
  const def: IconDef = ICONS[name] ?? ICONS.question;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={resolvedStrokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={isLabelled ? undefined : true}
      role={isLabelled ? "img" : undefined}
      focusable="false"
      style={mergedStyle}
      {...props}
    >
      {(def.stroke ?? []).map((d, index) => (
        <path key={`s${index}`} d={d} />
      ))}
      {(def.fill ?? []).map((d, index) => (
        <path key={`f${index}`} d={d} fill="currentColor" stroke="none" />
      ))}
    </svg>
  );
}
