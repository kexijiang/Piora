/** Deterministic protocol fixture. Not a generated-model or semantic benchmark. */
export const counterPlan = () => ({
  planVersion: 1, id: 'counter', title: 'Step counter', purpose: 'Observe explicit state changes', assumptions: [],
  playback: {mode:'continuous'},
  inputs: [{id:'start',label:'Starting value',meaning:'Initial count when resetting the process',type:'number',value:2,min:0,max:20,step:1}],
  stateSchema: {type:'object',properties:{count:{type:'integer',minimum:0,maximum:10000}},required:['count'],additionalProperties:false},
  document: {html:'<section><label for="start">Starting value</label><input id="start" data-input="start"><p data-text="count"></p><button data-event="increment">Add one</button></section>',css:'section{display:grid;gap:12px}'},
  viewports: [], initialSnapshot: 'Step counter ready.',
  program: `function init(inputs,ctx){return {count:inputs.start};}
function reduce(state,event,ctx){return {count:event.type==='input'?ctx.inputs.start:event.type==='click'?state.count+1:state.count};}
function advance(state,dt,ctx){return {count:state.count+1};}
function project(state,inputs,ctx){return {summary:'Count: '+state.count,bindings:{count:state.count},playback:{finished:false}};}`,
});

export const discreteCounterPlan = () => {
  const plan = counterPlan();
  plan.playback = {mode:'discrete',stepEvent:'increment'};
  plan.program = plan.program.replace('function advance(state,dt,ctx){return {count:state.count+1};}', 'function advance(){throw new Error("Discrete apps must not invoke advance");}')
    .replace('playback:{finished:false}', 'playback:{finished:state.count>=5}');
  return plan;
};

/** Stateful input fixture: a single missed release would keep advancing or dragging. */
export const heldInputPlan = () => ({
  planVersion: 1, id: 'held-input', title: 'Held input lifecycle', purpose: 'Verify interruption and checkpoint semantics', assumptions: [],
  playback: {mode:'continuous'}, inputs: [], viewports: [], initialSnapshot: 'Position 20; inputs released.',
  stateSchema: {type:'object',properties:{x:{type:'number',minimum:0,maximum:1000},held:{type:'boolean'},drag:{type:'boolean'}},required:['x','held','drag'],additionalProperties:false},
  document: {html:'<section><div data-event="keys" tabindex="0" aria-label="Hold right arrow">Hold right arrow</div><button data-event="other">Other control</button><svg viewBox="0 0 100 100" width="200" height="200"><circle data-bind="cx:x" cy="50" r="8" fill="blue" data-event="point" tabindex="0" aria-label="Drag point"></circle></svg><p data-text="state"></p></section>',css:'section{display:grid;gap:12px}'},
  program: `function init(){return {x:20,held:false,drag:false};}
function reduce(state,event){
  if(event.type==='blur')return {x:state.x,held:false,drag:false};
  if(event.id==='keys'&&event.key==='ArrowRight'&&event.type==='keydown')state.held=true;
  if(event.key==='ArrowRight'&&event.type==='keyup')state.held=false;
  if(event.id==='point'){
    if(event.type==='pointerdown')state.drag=true;
    if(event.type==='pointermove'&&state.drag)state.x=Math.max(0,Math.min(100,event.x));
    if(event.type==='pointerup'||event.type==='pointercancel')state.drag=false;
  }
  return state;
}
function advance(state){if(state.held)state.x=Math.min(1000,state.x+1);return state;}
function project(state){return {summary:JSON.stringify(state),bindings:{x:state.x,state:JSON.stringify(state)},playback:{finished:false}};}`,
});
