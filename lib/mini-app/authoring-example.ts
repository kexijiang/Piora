import type { MiniAppPlan1 } from "./plan";

/** Complete tool arguments; schema, compiler and VM tests execute this exact object. */
export function miniAppAuthoringExample(): MiniAppPlan1 {
  return {
    planVersion: 1, id: "stepExample", title: "Step example", purpose: "Explore a bounded process one step at a time.",
    assumptions: ["This is a protocol example, not a template for the user's task."],
    inputs: [{ id: "start", label: "Starting count", meaning: "The first count after reset or input change", type: "number", value: 0, min: 0, max: 6, step: 1 }],
    stateSchema: { type: "object", properties: {
      count: { type: "number", minimum: 0, maximum: 6 },
      phase: { type: "string", maxLength: 8, enum: ["active", "complete"] },
    }, required: ["count", "phase"], additionalProperties: false },
    document: { html: '<section><h2>Step example</h2><input data-input="start"><p data-text="explanation"></p><button data-event="next">Next step</button></section>',
      css: 'section{display:grid;gap:12px}p{color:var(--text)}' },
    viewports: [], playback: { mode: "discrete", stepEvent: "next" },
    program: `const LIMIT=6;
function makeState(count){return {count:count,phase:count>=LIMIT?'complete':'active'};}
function init(inputs,ctx){return makeState(inputs.start);}
function reduce(state,event,ctx){if(event.type==='input'&&event.id==='start')return makeState(ctx.inputs.start);if(event.type==='click'&&event.id==='next')return makeState(Math.min(LIMIT,state.count+1));return state;}
function advance(state,dt,ctx){return state;}
function project(state,inputs,ctx){const text='Count: '+state.count+'; '+state.phase;return {summary:text,bindings:{explanation:text},playback:{finished:state.phase==='complete'}};}`,
    initialSnapshot: "A bounded counter with a starting value and one-step control.",
  };
}
