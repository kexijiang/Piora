"use client";

import type { CSSProperties, ReactNode } from "react";
import { a2uiChildren, a2uiPath, type A2uiDocument } from "../../lib/a2ui/document";
import type { UiRichNode } from "../../lib/intelligent-ui/rich-protocol";
import styles from "./A2uiLayout.module.css";

const justify: Record<string, string> = { start: "flex-start", end: "flex-end", center: "center", stretch: "stretch", spaceAround: "space-around", spaceBetween: "space-between", spaceEvenly: "space-evenly" };
export function A2uiLayout({ document, nodes, disabled, change, renderNode }: {
  document: A2uiDocument; nodes: UiRichNode[]; disabled: boolean;
  change(id: string, value: string | number | boolean): void; renderNode(node: UiRichNode): ReactNode;
}) {
  const components = new Map(document.components.map(c => [c.id, c])), projected = new Map(nodes.map(node => [node.id, node]));
  function render(id: string): ReactNode {
    const c = components.get(id)!;
    const style: CSSProperties = { ...(typeof c.weight === "number" ? { flexGrow: c.weight } : {}),
      ...(typeof c.justify === "string" ? { justifyContent: justify[c.justify] } : {}), ...(typeof c.align === "string" ? { alignItems: justify[c.align] } : {}) };
    if (c.component === "Row" || c.component === "Column") return <div key={id} data-a2ui-component={c.component} className={c.component === "Row" ? styles.row : styles.column} style={style}>{a2uiChildren(c).map(render)}</div>;
    if (c.component === "Card") return <section key={id} data-a2ui-component="Card" className={styles.card} style={style}>{render(c.child as string)}</section>;
    if (c.component === "Divider") return <hr key={id} className={styles.divider} data-axis={c.axis} style={style} />;
    if (c.component === "Button") {
      const call = (c.action as { functionCall: { args: { input: string; value: string | number | boolean } } }).functionCall;
      return <button key={id} className={styles.button} style={style} data-variant={c.variant} type="button" disabled={disabled} onClick={() => change(call.args.input, call.args.value)}>{String(components.get(c.child as string)!.text)}</button>;
    }
    const control = ["PioraNumber", "PioraChoice", "Slider", "CheckBox"].includes(c.component);
    const node = projected.get(control ? a2uiPath(c.value, "inputs")! : id);
    return node ? <div key={id} data-a2ui-component={c.component} className={c.variant === "caption" ? styles.caption : styles.item} style={style}>{renderNode(node)}</div> : null;
  }
  return <div className={styles.root} data-a2ui-version="1.0">{render("root")}</div>;
}
