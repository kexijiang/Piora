import type { CSSProperties } from "react";

declare module "react-syntax-highlighter/dist/esm/styles/prism/*" {
  const style: Record<string, CSSProperties>;
  export default style;
}
