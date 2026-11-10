import type { MiniAppDocumentNode } from "./document";
import type { MiniAppRepeat, MiniAppRepeatRow, MiniAppScalar } from "./repeat";
import type { JsonRecord } from "./json";

type Control = HTMLInputElement | HTMLSelectElement;
interface RowView {
  root: HTMLElement;
  texts: Array<{ target: Element; id: string }>;
  attributes: Array<{ target: Element; id: string; name: string }>;
  fields: Map<string, { target: Control; pending: number }>;
}

/** Generated data only fills validated nodes. Reordering moves existing rows;
 * neither HTML parsing nor model code runs in this renderer. */
export class MiniAppRepeatRenderer {
  private readonly rows = new Map<string, RowView>();
  private revision = 0;
  constructor(private readonly container: HTMLElement, private readonly definition: MiniAppRepeat,
    private readonly nextSerial: () => number, private readonly send: (event: JsonRecord) => void) {}

  private create(key: string): RowView {
    const row: RowView = { root: undefined!, texts: [], attributes: [], fields: new Map() };
    const event = (type: string, id: string, serial: number, value?: MiniAppScalar) => {
      if (!row.root.isConnected || !this.revision || this.rows.get(key) !== row) return;
      this.send({ type, id, repeat: this.definition.id, key, frame: this.revision, serial, ...(value === undefined ? {} : { value }) });
    };
    const build = (node: MiniAppDocumentNode): Node => {
      if (node.type === "text") return document.createTextNode(node.text);
      const target = node.svg ? document.createElementNS("http://www.w3.org/2000/svg", node.tag) : document.createElement(node.tag);
      for (const [name, value] of Object.entries(node.attrs)) if (name !== "data-bind") target.setAttribute(name, value);
      if (node.attrs["data-text"]) row.texts.push({ target, id: node.attrs["data-text"] });
      for (const binding of (node.attrs["data-bind"] ?? "").split(";").filter(Boolean)) {
        const [name, id] = binding.trim().split(":"); row.attributes.push({ target, id, name });
      }
      if (node.attrs["data-field"]) {
        const id = node.attrs["data-field"], field = { target: target as Control, pending: 0 };
        row.fields.set(id, field);
        target.addEventListener("input", input => {
          if (!input.isTrusted) return;
          const control = field.target;
          const value = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked
            : control instanceof HTMLInputElement && ["number", "range"].includes(control.type) ? control.value === "" ? null : Number(control.value) : control.value;
          if (value === null || typeof value === "number" && !Number.isFinite(value)) return;
          field.pending = this.nextSerial(); event("item-input", id, field.pending, value);
        });
      }
      if (node.attrs["data-event"]) target.addEventListener("click", click => {
        if (click.isTrusted && (click.target as Element).closest("[data-event]") === target) event("item-click", node.attrs["data-event"], this.nextSerial());
      });
      for (const child of node.children) target.append(build(child));
      return target;
    };
    row.root = build(this.definition.template[0]) as HTMLElement;
    row.root.dataset.rowKey = key;
    return row;
  }

  update(data: MiniAppRepeatRow[], identity: { revision: number; ack: number }): void {
    this.revision = identity.revision;
    const active = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : undefined;
    const previousRows = [...this.rows.values()];
    const focusedIndex = active ? previousRows.findIndex(row => row.root.contains(active)) : -1;
    const selector = active?.hasAttribute("data-field") ? `[data-field="${active.getAttribute("data-field")}"]`
      : active?.hasAttribute("data-event") ? `[data-event="${active.getAttribute("data-event")}"]` : "input,select,button,[tabindex]";
    const selection = active instanceof HTMLInputElement && active.type === "text" ? [active.selectionStart, active.selectionEnd] : undefined;
    const wanted = new Set(data.map(row => row.key));
    for (const [key, row] of this.rows) if (!wanted.has(key)) { row.root.remove(); this.rows.delete(key); }
    const ordered: RowView[] = [];
    for (const [index, value] of data.entries()) {
      let row = this.rows.get(value.key);
      if (!row) { row = this.create(value.key); this.rows.set(value.key, row); }
      ordered.push(row);
      if (this.container.children[index] !== row.root) this.container.insertBefore(row.root, this.container.children[index] ?? null);
      for (const binding of row.texts) binding.target.textContent = String(value.bindings[binding.id]);
      for (const binding of row.attributes) binding.target.setAttribute(binding.name, String(value.bindings[binding.id]));
      for (const [id, field] of row.fields) {
        // A frame for an earlier keystroke must not overwrite newer local input.
        if (field.pending > identity.ack) continue;
        const next = value.bindings[id];
        if (field.target instanceof HTMLInputElement && field.target.type === "checkbox") field.target.checked = Boolean(next);
        else if (field.target.value !== String(next)) field.target.value = String(next);
      }
    }
    // Map iteration follows display order for the next deletion/focus decision.
    this.rows.clear(); data.forEach((row, index) => this.rows.set(row.key, ordered[index]));
    if (active?.isConnected) {
      if (document.activeElement !== active) active.focus({ preventScroll: true });
      if (selection && selection[0] !== null && selection[1] !== null) (active as HTMLInputElement).setSelectionRange(selection[0], selection[1]);
    } else if (active) {
      const neighbor = ordered[Math.min(Math.max(0, focusedIndex), ordered.length - 1)];
      const target = neighbor?.root.querySelector<HTMLElement>(selector) ?? neighbor?.root.querySelector<HTMLElement>("input,select,button,[tabindex]");
      if (target) target.focus({ preventScroll: true });
      else { this.container.tabIndex = -1; this.container.focus({ preventScroll: true }); }
    }
  }
}
