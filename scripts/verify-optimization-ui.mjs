import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { verifyRuntimeUi, verifyArchivedBulkUi } from "./optimization-runtime-ui.mjs";

// Run against a started dev server. The dedicated browser gets synthetic responses;
// every non-GET request is rejected locally, so this never edits user conversations.
const executable = process.env.AGENT_BROWSER_EXECUTABLE || "agent-browser";
const session = process.env.PIORA_TEST_BROWSER || `piora-optimization-${Date.now()}`;
const output = path.resolve(".verification/optimization");
mkdirSync(output, { recursive: true });
const results = [];
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
function saveReport(report) {
  const json = JSON.stringify(report, null, 2);
  writeFileSync(path.join(output, "report.json"), json);
  writeFileSync(path.join(output, `report-${runStamp}.json`), json);
}
function command(args, input) {
  // On Windows the browser daemon can inherit stdout. Files avoid waiting for
  // that long-lived process to close an otherwise completed CLI command's pipe.
  const logPath = path.join(output, "command-output.json");
  const log = openSync(logPath, "w");
  const errors = openSync(path.join(output, "command-error.log"), "w");
  let failure;
  try {
    execFileSync(executable, ["--session", session, "--json", ...args], {
      encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", log, errors],
      windowsHide: true, timeout: 40_000,
    });
  } catch (error) { failure = error; }
  finally { closeSync(log); closeSync(errors); }
  const raw = readFileSync(logPath, "utf8");
  if (failure) throw new Error(`${args[0]} failed: ${raw || readFileSync(path.join(output, "command-error.log"), "utf8") || failure.message}`);
  const result = JSON.parse(raw);
  if (!result.success) throw new Error(result.error);
  return result.data;
}
const evaluate = (code) => command(["eval", "--stdin"], code).result;
const resize = (width, height) => {
  command(["set", "viewport", String(width), String(height)]);
  evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
};
const wait = (code) => {
  const deadline = Date.now() + 60_000;
  do {
    if (evaluate(`Boolean(${code})`)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  } while (Date.now() < deadline);
  throw new Error(`Readiness condition timed out: ${code}`);
};
const clickButton = (name, scope) => {
  const selector = evaluate(`(() => {
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document"};
    const buttons = Array.from(root.querySelectorAll('button'));
    const button = buttons.find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === ${JSON.stringify(name)} && e.getClientRects().length && !e.closest('[inert]'));
    if (!button) throw new Error('Button not found: '+${JSON.stringify(name)});
    button.scrollIntoView({block:'nearest',inline:'nearest'});
    document.querySelectorAll('[data-audit-button]').forEach(e=>e.removeAttribute('data-audit-button'));
    button.setAttribute('data-audit-button','true');
    return '[data-audit-button="true"]';
  })()`);
  command(["click", selector]);
};
function check(name, value) { assert.ok(value, name); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
const metrics = () => evaluate(`(() => {
  const scroll = document.querySelector('#chat-scroll-container');
  const list = scroll?.querySelector('[data-virtual-list]');
  return { total: Number(list?.dataset.virtualTotal), mounted: list?.querySelectorAll('[data-virtual-key]').length,
    top: scroll?.scrollTop, height: scroll?.clientHeight, scrollHeight: scroll?.scrollHeight,
    users: Array.from(list?.querySelectorAll('[data-chat-user-index]') || []).map(e => Number(e.dataset.chatUserIndex)),
    overflow: document.documentElement.scrollWidth > innerWidth };
})()`);

try {
  if (process.env.PIORA_BULK_READY) {
    verifyArchivedBulkUi({ evaluate, wait, check, clickButton });
    check("no browser runtime errors", (command(["errors"]).errors ?? []).length === 0);
    saveReport({ date:new Date().toISOString(),results, scope:"bulk deletion follow-up" });
  } else {
  if (!process.env.PIORA_CHAT_READY) {
  if (!process.env.PIORA_REUSE_TEST_PAGE) command(["open", process.env.PIORA_TEST_URL || "http://127.0.0.1:30141"]);
  resize(1440, 900);
  wait(`document.querySelector('[data-session-drag-id]')`);
  if (evaluate(`!!document.querySelector('button[aria-label="显示侧边栏"]')`)) clickButton("显示侧边栏");
  wait(`!document.querySelector('#session-sidebar')?.inert`);
  clickButton("设置");
  wait(`Array.from(document.querySelectorAll('h2')).some(e=>e.textContent==='通用')`);
  check("settings button opens General rather than receiving a click event as its category", true);
  command(["find", "placeholder", "搜索设置…", "fill", "字体"]);
  wait(`document.querySelector('[aria-label="设置搜索结果"] button')`);
  command(["click", '[aria-label="设置搜索结果"] button']);
  wait(`document.activeElement?.getAttribute('data-settings-id') === 'appearance.font'`);
  check("settings search focuses and highlights the exact font option", evaluate(`!!document.querySelector('[data-settings-id="appearance.font"][data-settings-highlighted="true"]')`));
  command(["screenshot", path.join(output, "settings-font.png")]);
  resize(390, 844);
  check("settings fits a 390px viewport", evaluate("document.documentElement.scrollWidth <= innerWidth"));
  command(["screenshot", path.join(output, "settings-mobile.png")]);
  resize(1440, 900);
  clickButton("返回 Piora");
  if (evaluate(`!!document.querySelector('button[aria-label="显示侧边栏"]')`)) clickButton("显示侧边栏");
  wait(`!document.querySelector('#session-sidebar')?.inert`);
  wait(`document.querySelector('[data-session-drag-id]')`);

  const id = evaluate(`(() => {
    const id = document.querySelector('[data-session-drag-id]').dataset.sessionDragId;
    const original = window.fetch.bind(window);
    const messages = [], entryIds = [];
    for (let i=0;i<500;i++) {
      messages.push({role:'user',content:'AUDIT user '+i+'\\n'+Array.from({length:20},(_,n)=>'Line '+n+' for task '+i).join('\\n'),timestamp:1700000000000+i*1000});
      entryIds.push('audit-u-'+i);
      messages.push({role:'assistant',content:[{type:'thinking',thinking:'AUDIT reasoning '+i}],timestamp:1700000000001+i*1000}); entryIds.push('audit-p-'+i);
      messages.push({role:'assistant',content:[{type:'text',text:'AUDIT answer '+i+'\\n\\n'+('A realistic paragraph with variable wrapping. '.repeat(15))}],timestamp:1700000000002+i*1000}); entryIds.push('audit-a-'+i);
    }
    messages[1].content=[{type:'thinking',thinking:'',deferred:true},{type:'toolCall',toolCallId:'audit-read',toolName:'read',input:{path:'audit.txt'}}];
    messages.splice(2,0,{role:'toolResult',toolCallId:'audit-read',content:[{type:'text',text:'AUDIT tool output'}]});entryIds.splice(2,0,'audit-result');
    window.__pioraAudit = {id, messages, entryIds, original, writes:[], catalog:null, deferredReads:0};
    window.fetch = async (input, init) => {
      const url = new URL(typeof input==='string'?input:input.url, location.href);
      const method = init?.method || input?.method || 'GET';
      if (url.pathname==='/api/agent/'+id && method==='POST' && JSON.parse(init?.body || '{}').type==='get_commands') return Response.json({success:true,data:{commands:[]}});
      if (url.origin===location.origin && method!=='GET') window.__pioraAudit.writes.push({method,path:url.pathname});
      if (window.__pioraAudit.restoreSucceeds && method==='POST' && url.pathname==='/api/sessions/audit-trash/restore') return Response.json({ok:true});
      if (window.__pioraAudit.catalog && method==='PATCH' && url.pathname==='/api/sessions/'+id) return Response.json({success:true});
      if (url.origin===location.origin && method!=='GET') return Response.json({error:'AUDIT simulated write failure'}, {status:503});
      if (url.pathname==='/api/sessions' && window.__pioraAudit.catalog) return Response.json({sessions:window.__pioraAudit.catalog,runningSessionIds:[]});
      if (url.pathname==='/api/sessions/'+id+'/deletion') return Response.json({count:3,running:1,sessionIds:[id,'audit-child-0','audit-child-1']});
      if (url.pathname==='/api/sessions/'+id+'/entries/audit-p-0/thinking') { window.__pioraAudit.deferredReads++;await new Promise(resolve=>setTimeout(resolve,250));return Response.json({thinking:'AUDIT deferred reasoning\\n\\n'+String.fromCharCode(96).repeat(3)+'js\\nconst audit = true;\\n'+String.fromCharCode(96).repeat(3)}); }
      if (url.pathname==='/api/sessions/trash') return Response.json({sessions:[{id:'audit-trash',title:'AUDIT deleted conversation',cwd:'test memory',count:3,trashedAt:Date.now(),expiresAt:Date.now()+86400000*30}]});
      if (url.pathname==='/api/sessions/search') return Response.json({durationMs:1,truncated:false,results:url.searchParams.get('q')==='AUDIT lookup'?Array.from({length:100},(_,i)=>({sessionId:id,entryId:'audit-u-'+(i*5),role:'user',title:'AUDIT result '+i,snippet:'AUDIT lookup '+i,matchStart:0,matchLength:5,timestamp:new Date().toISOString(),projectLabel:'Piora',archived:false})):[]});
      if (url.pathname==='/api/sessions/'+id) return Response.json({sessionId:id,filePath:'audit-memory-only',tree:[],leafId:entryIds.at(-1),context:{messages,entryIds,thinkingLevel:'off',model:null}});
      if (url.pathname==='/api/sessions/'+id+'/state') return Response.json({running:false});
      return original(input,init);
    };
    return id;
  })()`);
  command(["click", `[data-session-drag-id="${id}"]`]);
  }
  wait(`document.querySelector('#chat-scroll-container [data-virtual-total="1500"]')`);
  wait(`document.querySelector('[data-chat-user-index="499"]')`);
  check("1,500-row chat opens at the latest turn with bounded mounted rows", metrics().mounted < 80);
  command(["screenshot", path.join(output, "chat-tail.png")]);

  // The first minimap marker is a real UI navigation target, not a synthetic scroll.
  command(["click", 'button[aria-label^="跳转到第 1 条用户消息"]']);
  wait(`document.querySelector('[data-chat-user-index="0"]')`);
  wait(`!document.querySelector('[data-minimap-preview-box]')`);
  check("timeline reaches the oldest user without mounting all history", metrics().mounted < 80 && metrics().users.includes(0));
  command(["click", '[data-chat-user-index="0"] .message-user-expand']);
  wait(`document.querySelector('[data-chat-user-index="0"] .message-user-expand')?.getAttribute('aria-expanded')==='true'`);
  command(["click", 'button[aria-label^="跳转到第 500 条用户消息"]']);
  wait(`document.querySelector('[data-chat-user-index="499"]')`);
  check("scrolling forward recycles the oldest expanded row", !evaluate(`!!document.querySelector('[data-chat-user-index="0"]')`));
  command(["click", 'button[aria-label^="跳转到第 1 条用户消息"]']);
  wait(`document.querySelector('[data-chat-user-index="0"] .message-user-expand')?.getAttribute('aria-expanded')==='true'`);
  check("expanded user content survives real DOM unmount and remount", true);
  command(["scrollintoview", '[data-virtual-key="process:audit-u-0"] button']);
  command(["click", '[data-virtual-key="process:audit-u-0"] button']);
  const processRow = '[data-chat-entry-id="audit-p-0"]';
  wait(`document.querySelector('${processRow} .thinking-block-trigger')`);
  command(["scrollintoview", `${processRow} .thinking-block-trigger`]);
  command(["click", `${processRow} .thinking-block-trigger`]);
  wait(`document.querySelector('${processRow}')?.textContent.includes('const audit = true;')`);
  command(["scrollintoview", `${processRow} .tool-call-toggle`]);
  command(["click", `${processRow} .tool-call-toggle`]);
  clickButton("诊断信息", processRow);
  command(["click", 'button[data-minimap-node-index="499"]']);
  wait(`!document.querySelector('${processRow}')`);
  command(["click", 'button[data-minimap-node-index="0"]']);
  wait(`document.querySelector('${processRow} .thinking-block-trigger')?.getAttribute('aria-expanded')==='true'`);
  check("deferred thinking, process, tool output and diagnostics retain expansion after recycling", evaluate(`document.querySelector('${processRow} .tool-call-toggle')?.getAttribute('aria-expanded')==='true' && Array.from(document.querySelectorAll('${processRow} button')).some(e=>e.textContent.includes('诊断信息') && e.getAttribute('aria-expanded')==='true') && window.__pioraAudit.deferredReads===1`));
  command(["screenshot", path.join(output, "chat-oldest-expanded.png")]);
  resize(760, 900);
  wait(`document.querySelector('#chat-scroll-container')?.clientWidth < 760`);
  check("chat stays bounded after changing column width", metrics().mounted < 80);
  resize(390, 844);
  check("chat fits a 390px viewport", !metrics().overflow);
  command(["screenshot", path.join(output, "chat-mobile.png")]);
  resize(1440, 900);
  if (evaluate(`!!document.querySelector('button[aria-label="显示侧边栏"]')`)) clickButton("显示侧边栏");
  wait(`!document.querySelector('#session-sidebar')?.inert`);
  const selectedRow = '[data-session-drag-id][aria-selected="true"]';
  command(["hover", `${selectedRow} .sidebar-session-row`]);
  command(["click", `${selectedRow} button[title="重命名"]`]);
  const renameWidth = evaluate(`document.querySelector('${selectedRow} input').getBoundingClientRect().width`);
  command(["fill", `${selectedRow} input`, "AUDIT rename retained input"]);
  command(["press", "Enter"]);
  wait(`document.querySelector('${selectedRow} [role="alert"]')?.textContent.includes('AUDIT simulated')`);
  check("failed rename retains an editable input and a readable error", evaluate(`document.querySelector('${selectedRow} input')?.value==='AUDIT rename retained input' && document.querySelector('${selectedRow} input').getBoundingClientRect().width>=${renameWidth}-1`));
  command(["screenshot", path.join(output,"rename-error-fixed.png")]);
  command(["press", "Escape"]);
  command(["hover", `${selectedRow} .sidebar-session-row`]);
  command(["click", `${selectedRow} button[title="删除"]`]);
  wait(`document.querySelector('#confirmation-message')`);
  check("deletion confirmation includes the subtree and running count", evaluate(`document.querySelector('#confirmation-message').textContent.includes('3') && document.querySelector('#confirmation-message').textContent.includes('1')`));
  clickButton("删除", '[role="dialog"]');
  wait(`document.querySelector('${selectedRow} [role="alert"]')?.textContent.includes('AUDIT simulated')`);
  check("failed deletion keeps the row available", evaluate(`!!document.querySelector('${selectedRow}')`));

  clickButton("搜索");
  command(["fill", '[role="dialog"] input', "AUDIT lookup"]);
  wait(`document.querySelectorAll('[role="dialog"] [data-search-index]').length===100`);
  check("all 100 returned search matches are accessible", true);
  command(["scrollintoview", '[data-search-index="99"]']);
  command(["click", '[data-search-index="99"]']);
  wait(`document.querySelector('[data-chat-entry-id="audit-u-495"].is-search-target')`);
  check("the 100th search match reveals and highlights a bounded history window", metrics().mounted<80);

  clickButton("设置");
  for (const [query,id] of [["自动滚动","conversation.autoScroll"],["完成通知","conversation.notifications"],["命令面板","shortcuts.palette"]]) {
    command(["fill", 'input[placeholder="搜索设置…"]', query]);
    wait(`document.querySelector('[aria-label="设置搜索结果"] button')`);
    command(["click", '[aria-label="设置搜索结果"] button']);
    wait(`document.activeElement?.getAttribute('data-settings-id')===${JSON.stringify(id)}`);
    check(`settings search focuses ${id}`, true);
  }
  clickButton("添加与配置能力");
  check("capability overview explains install, configure and connect tasks", evaluate(`['安装能力','选择智能体可用的能力','连接设备与远程访问'].every(s=>document.body.innerText.includes(s))`));
  command(["screenshot", path.join(output,"capabilities.png")]);
  clickButton("回收站");
  wait(`document.body.innerText.includes('AUDIT deleted conversation')`);
  clickButton("恢复");
  wait(`Array.from(document.querySelectorAll('[role="alert"]')).some(e=>e.textContent.includes('AUDIT simulated'))`);
  check("failed trash restore preserves the recoverable item and offers retry", evaluate(`document.body.innerText.includes('AUDIT deleted conversation') && document.body.innerText.includes('重试')`));
  evaluate(`window.__pioraAudit.restoreSucceeds=true`);
  clickButton("恢复");
  wait(`document.querySelector('a[href="?session=audit-trash"]')`);
  check("successful restore provides a direct conversation link", evaluate(`!!document.querySelector('[role="status"] a[href="?session=audit-trash"]')`));
  clickButton("返回 Piora");
  clickButton("隐藏侧边栏");
  check("closed sidebar is inert and rejects programmatic focus", evaluate(`(() => {const sidebar=document.querySelector('#session-sidebar');sidebar.querySelector('button').focus();return sidebar.inert && !sidebar.contains(document.activeElement)})()`));
  clickButton("显示侧边栏");
  wait(`!document.querySelector('#session-sidebar')?.inert`);
  const chatMetrics=metrics();
  const runtime=verifyRuntimeUi({ command, evaluate, wait, check, clickButton, metrics, resize });
  check("no browser runtime errors", (command(["errors"]).errors ?? []).length === 0);
  saveReport({ date:new Date().toISOString(),results,metrics:chatMetrics,runtime });
  }
} catch (error) {
  try { command(["screenshot", path.join(output,"failure.png")]); } catch { /* Preserve the original failure. */ }
  saveReport({date:new Date().toISOString(),results,error:String(error)});
  throw error;
} finally {
  if (!process.env.PIORA_KEEP_TEST_BROWSER) command(["close"]);
}
