// Called after the main UI fixture is installed. All generated state stays in
// the isolated browser; successful responses below never reach the real server.
export function verifyRuntimeUi({ command, evaluate, wait, check, clickButton, metrics, resize }) {
  evaluate(`(() => {
    const audit=window.__pioraAudit, previousFetch=window.fetch.bind(window), NativeSource=window.EventSource;
    if (!audit) throw new Error('Run the UI fixture first');
    audit.running=false;
    class FixtureSource {
      static CONNECTING=0; static OPEN=1; static CLOSED=2;
      readyState=1;
      constructor(url) {
        if (!String(url).startsWith('/api/agent/'+audit.id+'/events')) return new NativeSource(url);
        audit.source=this;
        setTimeout(()=>this.emit({type:'connected'}),20);
      }
      emit(event) { this.onmessage?.({data:JSON.stringify(event)}); }
      close() { this.readyState=2; }
    }
    window.EventSource=FixtureSource;
    window.fetch=async (input,init) => {
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const method=init?.method || input?.method || 'GET';
      if(url.pathname==='/api/agent/'+audit.id) {
        if(method==='GET') return Response.json({running:true,state:{isStreaming:audit.running,isPromptRunning:audit.running,runtime:audit.running?'running':'idle'}});
        const body=JSON.parse(init?.body || '{}');
        if(body.type==='prompt') {
          audit.running=true; audit.chunks=0; audit.streamText='AUDIT streaming answer: ';
          audit.user={role:'user',content:body.message,timestamp:Date.now()};
          audit.message={role:'assistant',content:[{type:'text',text:audit.streamText}],timestamp:Date.now()};
          audit.source.emit({type:'agent_start'});
          audit.source.emit({type:'message_start',message:audit.message});
          audit.timer=setInterval(()=>{
            const delta='chunk '+(++audit.chunks)+' ';
            audit.streamText+=delta;
            audit.source.emit({type:'message_delta',index:0,field:'text',delta});
          },32);
          audit.finish=()=>{
            clearInterval(audit.timer);
            const message={...audit.message,content:[{type:'text',text:audit.streamText}]};
            audit.messages.push(audit.user,message); audit.entryIds.push('audit-new-user','audit-new-answer');
            audit.source.emit({type:'message_end',message}); audit.source.emit({type:'agent_end'});
            audit.running=false; audit.source.emit({type:'prompt_done'});
          };
          return Response.json({success:true,data:{}});
        }
      }
      return previousFetch(input,init);
    };
  })()`);
  command(["click", 'button[data-minimap-node-index="0"]']);
  wait(`document.querySelector('[data-chat-user-index="0"]')`);
  command(["fill", 'textarea[placeholder^="消息"]', "AUDIT newly sent user"]);
  clickButton("发送");
  wait(`window.__pioraAudit.chunks>=5 && document.querySelector('[data-chat-user-index="500"]')`);
  check("sending from old history mounts and locates the new user", metrics().mounted < 80 && metrics().users.includes(500));
  evaluate(`(() => {
    const audit=window.__pioraAudit; audit.historyTextChanges=0; audit.frames=[]; audit.lastFrame=performance.now();
    audit.observer=new MutationObserver(records=>{audit.historyTextChanges+=records.filter(r=>r.type==='characterData').length});
    audit.observer.observe(document.querySelector('#chat-scroll-container [data-virtual-list]'),{characterData:true,subtree:true});
    audit.frame=function(time){audit.frames.push(time-audit.lastFrame);audit.lastFrame=time;if(audit.running)audit.frameId=requestAnimationFrame(audit.frame)};
    audit.frameId=requestAnimationFrame(audit.frame); audit.sampleStart=audit.chunks;
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  wait(`window.__pioraAudit.chunks-window.__pioraAudit.sampleStart>=60`);
  check("incremental output reaches the UI without rewriting historical text", evaluate(`document.body.innerText.includes('chunk 50') && window.__pioraAudit.historyTextChanges===0`) && metrics().mounted < 80);
  evaluate(`window.__pioraAudit.observer.disconnect();window.__pioraAudit.finish()`);
  wait(`window.__pioraAudit.source.readyState===2 && document.querySelector('[data-chat-entry-id="audit-new-answer"]')`);
  check("prompt_done settles the stream and retains the final answer", evaluate(`document.querySelector('[data-chat-entry-id="audit-new-answer"]').textContent.includes('AUDIT streaming answer')`));
  evaluate(`window.__pioraAudit.source.emit({type:'message_start',message:{role:'assistant',content:[{type:'text',text:'AUDIT stale ghost'}]}})`);
  check("late events cannot resurrect a finished streaming bubble", evaluate(`!document.body.innerText.includes('AUDIT stale ghost')`));
  evaluate(`(() => { const a=window.__pioraAudit;cancelAnimationFrame(a.frameId);const f=[...a.frames].sort((x,y)=>x-y);a.frameSample={count:f.length,p95:f[Math.floor(f.length*.95)],max:f.at(-1)}; })()`);

  // A synthetic successful rename triggers the app's real catalog refresh path.
  evaluate(`(() => {
    const a=window.__pioraAudit, cwd=${JSON.stringify(process.cwd())};
    a.catalog=Array.from({length:500},(_,i)=>({id:i?'audit-session-'+i:a.id,path:'memory-'+i,cwd,projectRoot:cwd,name:'AUDIT task '+i,created:new Date(1700000000000-i*1000).toISOString(),modified:new Date(1700000000000-i*1000).toISOString(),messageCount:1,firstMessage:'AUDIT task '+i}));
    for(let i=0;i<5;i++)a.catalog.push({...a.catalog[0],id:'audit-child-'+i,path:'child-memory-'+i,name:'AUDIT child '+i,parentSessionId:a.id});
  })()`);
  const selected = '[data-session-drag-id][aria-selected="true"]';
  command(["hover", `${selected} .sidebar-session-row`]);
  command(["click", `${selected} button[title="重命名"]`]);
  command(["fill", `${selected} input`, "AUDIT task 0"]);
  command(["press", "Enter"]);
  wait(`document.querySelector('[data-session-drag-id="audit-session-1"]')`);
  const more = evaluate(`(() => {const b=Array.from(document.querySelectorAll('button')).find(e=>/^显示另外 497 个会话$/.test(e.textContent.trim()));if(!b)throw new Error('Catalog expansion missing');b.setAttribute('data-audit-more','true');return '[data-audit-more]'})()`);
  command(["click", more]);
  wait(`document.querySelector('#session-sidebar [data-virtual-total="500"]')`);
  check("500 sidebar roots use a bounded DOM window", evaluate(`document.querySelectorAll('#session-sidebar [data-session-drag-id]').length<80`));
  evaluate(`document.querySelector('[data-session-drag-id][aria-selected="true"]').focus()`);
  command(["press", "End"]);
  wait(`document.activeElement?.dataset.sessionDragId==='audit-session-499'`);
  check("End key reaches an offscreen sidebar task", true);
  command(["press", "Home"]);
  wait(`document.activeElement?.dataset.sessionDragId===window.__pioraAudit.id`);
  command(["press", "ArrowRight"]);
  wait(`document.querySelector('[data-session-drag-id="audit-child-0"]')`);
  check("keyboard expansion reveals children and persists the choice", evaluate(`document.activeElement.getAttribute('aria-expanded')==='true' && Object.keys(localStorage).some(k=>k.startsWith('piora:expanded-branches:') && localStorage.getItem(k).includes(window.__pioraAudit.id))`));
  command(["press", "ArrowLeft"]);
  wait(`!document.querySelector('[data-session-drag-id="audit-child-0"]')`);
  const points = evaluate(`(() => {const source=document.querySelector('[data-session-drag-id][aria-selected="true"] .sidebar-session-row').getBoundingClientRect(),target=document.querySelector('[data-session-drag-id="audit-session-1"] .sidebar-session-row').getBoundingClientRect();return {sx:source.x+20,sy:source.y+source.height/2,tx:target.x+20,ty:target.bottom-3}})()`);
  command(["mouse", "move", String(Math.round(points.sx)), String(Math.round(points.sy))]);
  command(["mouse", "down"]);
  command(["wait", "350"]);
  command(["mouse", "move", String(Math.round(points.tx)), String(Math.round(points.ty))]);
  command(["mouse", "up"]);
  wait(`document.querySelector('#session-sidebar [data-session-drag-id]')?.dataset.sessionDragId==='audit-session-1'`);
  check("long-press dragging reorders the visible sidebar tasks", true);
  const sidebarMounted=evaluate(`document.querySelectorAll('#session-sidebar [data-session-drag-id]').length`);
  clickButton("新建无项目聊天");
  wait(`document.querySelector('main[aria-label="开始新任务"]')`);
  clickButton("设置");
  clickButton("添加与配置能力");
  wait(`document.body.innerText.includes('打开一个项目，即可安装并配置它的智能体能力。')`);
  check("projectless capability settings explain unavailable project actions", true);
  resize(390,844);
  check("projectless capability overview fits a narrow viewport", evaluate(`document.documentElement.scrollWidth<=innerWidth`));
  resize(1440,900);
  verifyArchivedBulkUi({ evaluate, wait, check, clickButton });
  return {sidebarMounted,frameSample:evaluate(`window.__pioraAudit.frameSample`)};
}

export function verifyArchivedBulkUi({ evaluate, wait, check, clickButton }) {
  // Start from a different section so a previous run also reloads the fixtures.
  if (!evaluate(`!!document.querySelector('.settings-content')`)) clickButton("设置");
  clickButton("通用");
  evaluate(`(() => {
    const a=window.__pioraAudit, previous=window.fetch.bind(window);
    a.archived=[{...a.catalog[0],id:'audit-archive-a',name:'AUDIT archived A'},{...a.catalog[0],id:'audit-archive-b',name:'AUDIT archived B'}];
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href),method=init?.method || input?.method || 'GET';
      if(url.pathname==='/api/sessions' && method==='GET')return Response.json({sessions:a.archived,runningSessionIds:[]});
      if(url.pathname==='/api/sessions/flags' && method==='GET')return Response.json({flags:Object.fromEntries(a.archived.map(s=>[s.id,{archived:true}]))});
      if(url.pathname==='/api/sessions/deletion' && method==='POST')return Response.json({count:3,unarchived:1,running:1,rootIds:['audit-archive-a','audit-archive-b'],sessionIds:['audit-archive-a','audit-archive-b','audit-child']});
      if(url.pathname==='/api/sessions/audit-archive-a' && method==='DELETE'){a.archived=a.archived.filter(s=>s.id!=='audit-archive-a');return Response.json({sessionIds:['audit-archive-a','audit-child'],trashedCount:2})}
      if(url.pathname==='/api/sessions/audit-archive-b' && method==='DELETE')return Response.json({error:'AUDIT second deletion failed'},{status:503});
      return previous(input,init);
    };
  })()`);
  clickButton("已归档的聊天");
  wait(`document.querySelector('.settings-content article [title="AUDIT archived A"]') && document.querySelector('.settings-content article [title="AUDIT archived B"]') && Array.from(document.querySelectorAll('.settings-content button')).some(e=>e.textContent.trim()==='全部删除')`);
  clickButton("全部删除");
  wait(`document.querySelector('#confirmation-message')`);
  check("bulk deletion explains unarchived descendants before confirmation", evaluate(`document.querySelector('#confirmation-message').textContent.includes('3') && document.querySelector('#confirmation-message').textContent.includes('未归档') && document.querySelector('#confirmation-message').textContent.includes('1')`));
  clickButton("全部删除", '[role="dialog"][aria-labelledby="confirmation-title"]');
  wait(`Array.from(document.querySelectorAll('[role="alert"]')).some(e=>e.textContent.includes('AUDIT second deletion failed'))`);
  check("partial bulk failure refreshes successful deletions and keeps failed items", evaluate(`!!document.querySelector('.settings-content article [title="AUDIT archived B"]') && !document.querySelector('.settings-content article [title="AUDIT archived A"]') && !document.querySelector('.settings-content').innerText.includes('无法加载已归档聊天')`));
}
