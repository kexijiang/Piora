import type { MiniAppPlan1 } from "./plan";

/** Executable protocol example; the generated task still supplies its own rules. */
export function miniAppRepeatExample(): MiniAppPlan1 {
  return {
    planVersion: 1, id: "packingList", title: "出行准备清单", purpose: "编辑、勾选、增删和调整准备事项的顺序，并保存当前清单。",
    assumptions: ["此协议示例最多展示 16 项；实际任务应按展开节点预算设计容量并向用户说明。"],
    inputs: [{ id: "newTitle", label: "新增事项", meaning: "点击添加后使用的事项名称", type: "text", value: "", maxLength: 80 }],
    stateSchema: { type: "object", properties: {
      next: { type: "integer", minimum: 4, maximum: 1_000_000 },
      items: { type: "array", maxItems: 16, items: { type: "object", properties: {
        key: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 80 },
        done: { type: "boolean" }, priority: { type: "string", maxLength: 4, enum: ["high", "low"] },
      }, required: ["key", "title", "done", "priority"], additionalProperties: false } },
    }, required: ["next", "items"], additionalProperties: false },
    document: { html: '<section><h2>出行准备清单</h2><p data-text="status"></p><label>新增事项<input data-input="newTitle"></label><button data-event="add">添加</button><ul data-repeat="tasks"><li><label><input data-field="done" type="checkbox" aria-label="完成">完成</label><input data-field="title" type="text" maxlength="80" aria-label="事项名称"><select data-field="priority" aria-label="优先级"><option value="high">优先</option><option value="low">普通</option></select><button data-event="up">上移</button><button data-event="remove">删除</button></li></ul></section>',
      css: 'section{display:grid;gap:12px}ul{display:grid;gap:8px;padding:0}li{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-panel)}p{color:var(--text-muted)}' },
    playback: { mode: "none" }, viewports: [],
    program: `function init(inputs,ctx){return {next:4,items:[{key:'task1',title:'订票',done:false,priority:'high'},{key:'task2',title:'收拾衣服',done:false,priority:'low'},{key:'task3',title:'带充电器',done:false,priority:'low'}]};}
function reduce(state,event,ctx){
 if(event.type==='click'&&event.id==='add'&&ctx.inputs.newTitle.trim()&&state.items.length<16&&state.next<1000000){state.items.push({key:'task'+state.next,title:ctx.inputs.newTitle.trim(),done:false,priority:'low'});state.next++;}
 if(event.repeat==='tasks')for(let i=0;i<state.items.length;i++){if(state.items[i].key!==event.key)continue;
  if(event.type==='item-input'){if(event.id==='title')state.items[i].title=event.value;if(event.id==='done')state.items[i].done=event.value;if(event.id==='priority')state.items[i].priority=event.value;}
  if(event.type==='item-click'&&event.id==='remove')state.items.splice(i,1);
  if(event.type==='item-click'&&event.id==='up'&&i>0){const previous=state.items[i-1];state.items[i-1]=state.items[i];state.items[i]=previous;}break;
 }return state;
}
function advance(state,dt,ctx){return state;}
function project(state,inputs,ctx){let done=0;const rows=[];for(let i=0;i<state.items.length;i++){const item=state.items[i];if(item.done)done++;rows.push({key:item.key,bindings:{title:item.title,done:item.done,priority:item.priority}});}const summary='已完成 '+done+' / '+state.items.length+' 项（最多 16 项）';return {summary:summary,bindings:{status:summary},repeats:{tasks:rows}};}`,
    initialSnapshot: "三项出行准备，可编辑、标记完成、调整顺序和增删。",
  };
}
