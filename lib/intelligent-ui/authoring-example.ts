import type { UiPlanV2 } from "./rich-plan";

/** Complete Plan2 arguments, verified with the provider schema and actual compiler. */
export function uiRichPlanAuthoringExample(): UiPlanV2 {
  return { planVersion: 2, id: "quantityExample", title: "Quantity example",
    inputs: [{ id: "quantity", label: "Quantity", valueType: "number", value: 2, min: 0, step: 1 }],
    derived: [{ id: "total", op: "multiply", args: [{ input: "quantity" }, { literal: 12 }] }],
    views: [{ id: "totalView", kind: "metric", label: "Total", value: { derived: "total" } },
      { id: "explanation", kind: "dynamicText", parts: ["At ", { input: "quantity" }, " items, the total is ", { derived: "total" }, "."] },
      { id: "basis", kind: "text", text: "Example unit price: 12. Use the user's actual rules and values in real tasks." }],
    layout: [{ id: "inputsGroup", type: "group", title: "Change quantity", columns: 1, nodeIds: ["quantity"] },
      { id: "resultsGroup", type: "group", title: "Result", columns: 1, nodeIds: ["totalView", "explanation", "basis"] }],
  };
}
