import assert from 'node:assert/strict';
import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {getAgentDir,ModelRuntime} from '@earendil-works/pi-coding-agent';
import {runDesktopScenario} from './desktop-e2e/harness.mjs';
import {startRealModelProxy} from './desktop-e2e/real-model-proxy.mjs';

const root=process.cwd(),args=process.argv.slice(2);
assert.ok(args.includes('--bindings'),'Explicit --bindings <json> is required');
const bindingsPath=resolve(args[args.indexOf('--bindings')+1]);
const bindings=JSON.parse(await readFile(bindingsPath,'utf8'));
assert.equal(bindings.version,1);assert.ok(bindings.cases.length>0);
assert.ok(['enabled','disabled'].includes(bindings.thinking));
const sha=value=>createHash('sha256').update(value).digest('hex');
const samples=await Promise.all(bindings.cases.map(async spec=>{
 const path=resolve(spec.source),bytes=await readFile(path),original=JSON.parse(bytes);
 assert.equal(sha(bytes),spec.sha256,'Bindings must identify the exact original report');assert.equal(original.status,'completed');
 const output=original.components.find(o=>o.publication?.status==='committed');assert.ok(output);
 return {spec,path,original,output};
}));
const cancel=new AbortController();for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>cancel.abort(new Error(event)));
const userAgent=getAgentDir(),runtime=await ModelRuntime.create({authPath:join(userAgent,'auth.json'),modelsPath:join(userAgent,'models.json'),allowModelNetwork:false});
const model=runtime.getModel('deepseek','deepseek-flash');
assert.ok(model&&/V4\.1/.test(model.name)&&runtime.hasConfiguredAuth('deepseek'),'Configured DeepSeek V4.1 Flash, without fallback, is required');
let directory,currentCase,currentPrompt;
const rows=[],requests=[],responses=[];
const persist=()=>writeFile(join(directory,'component-replay.json'),JSON.stringify({version:1,bindings:bindingsPath,
 scope:'Untouched generated components on isolated Windows development desktop, actual UI input, disk verification, reload and real-model follow-up; no human semantic acceptance.',
 configuredModel:{provider:model.provider,id:model.id,name:model.name,thinking:bindings.thinking,fallback:false},rows,requests,responses},null,2)+'\n');
const parts=m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(b=>b.type==='text').map(b=>b.text);
const scenario={
 id:'recorded-component-tasks',mode:'original-generation-live-followup',scope:'Original SDK records copied without changes; component inputs operated through UI',
 coverage:['independent arithmetic and boundary expectations','native UI inputs','disk snapshot','reload','real pinned-model follow-up'],
 limits:['new generation','two-human semantic review','other platforms','release packages','full recovery matrix'],
 async prepare(context){
  directory=context.directory;context.report.recordings=samples.map(({spec})=>({id:spec.id,source:spec.source,sha256:spec.sha256}));
  context.report.credentials='Memory-only real-provider relay; isolated profile has only a disposable loopback token';
  for(const {path} of samples){
   const source=join(dirname(path),'agent');await cp(join(source,'sessions'),join(context.paths.agent,'sessions'),{recursive:true,force:false,errorOnExist:true});
   for(const name of ['intelligent-ui','mini-app']){
    const destination=join(context.paths.agent,'piora',name);await mkdir(destination,{recursive:true});
    let files;try{files=await readdir(join(source,'piora',name));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const file of files)if(file.endsWith('.json'))await cp(join(source,'piora',name,file),join(destination,file),{force:false,errorOnExist:true});
   }
  }
  await writeFile(join(context.paths.agent,'piora','beta-features.json'),JSON.stringify({version:1,intelligentUi:true}));
  const relay=await startRealModelProxy({runtime,model,signal:context.signal,registerCleanup:context.registerCleanup,
   onRequest:async({id,body})=>{
    assert.equal(body.model,'deepseek-flash');const texts=(body.messages??[]).flatMap(parts);
    const purpose=currentPrompt&&texts.includes(currentPrompt)?'follow-up':'background';
    if(purpose==='follow-up')assert.equal(body.thinking?.type,bindings.thinking,'Verify the actual follow-up thinking mode');
    requests.push({id,caseId:currentCase,purpose,model:body.model,thinking:body.thinking,at:new Date().toISOString(),
     savedContext:texts.filter(text=>/^Saved interactive UI parameters and host publication results/.test(text)),digest:sha(JSON.stringify(body))});await persist();
   },
   onResponse:async response=>{const request=requests.find(r=>r.id===response.id);responses.push({...response,caseId:request?.caseId,purpose:request?.purpose});await persist();},
  });
  await writeFile(join(context.paths.agent,'models.json'),JSON.stringify({providers:{deepseek:{api:model.api,...relay,
   models:[{id:model.id,name:model.name,reasoning:model.reasoning,compat:model.compat,input:['text'],contextWindow:model.contextWindow,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  await writeFile(join(context.paths.agent,'settings.json'),JSON.stringify({packages:[],extensions:[],skills:[],retry:{enabled:false},defaultProvider:model.provider,defaultModel:model.id,enabledModels:[`${model.provider}/${model.id}`],defaultThinkingLevel:bindings.thinking==='enabled'?'medium':'off'}));
  await persist();
 },
 async run({page,origin,step,waitUntil,reload,screenshot}){
  const api=async path=>{const result=await page.evaluate(async path=>{const r=await fetch(path,{cache:'no-store'});return{status:r.status,data:await r.json()};},path);assert.equal(result.status,200);return result.data;};
  for(const {spec,path,original,output} of samples){
   currentCase=spec.id;currentPrompt=undefined;
   const row={id:spec.id,source:spec.source,sha256:spec.sha256,status:'running',checkpoints:[],semanticFindings:[...(spec.findings??[])],semanticReview:'pending-independent-human-review'};rows.push(row);await persist();
   try{await step(spec.id,async()=>{
    await page.goto(`${origin}/?session=${encodeURIComponent(original.sessionId)}`,{waitUntil:'domcontentloaded'});
    const input=output.surface.nodes.find(n=>n.id===spec.inputId);
    assert.equal(input.type,'number','These supplied discrete/threshold tasks do not require sliders');
    // A repaired original transcript can also contain read-only failed previews
    // with the same title. Require one writable answer, never choose first().
    const writable=page.getByRole('spinbutton',{name:input.label,exact:true}).and(page.locator(':enabled'));
    const surface=page.getByRole('region',{name:output.surface.title,exact:true}).filter({has:writable});
    await waitUntil(async()=>await surface.count()===1,'exactly one writable recorded component');
    const control=surface.getByRole('spinbutton',{name:input.label,exact:true});
    await control.waitFor();await waitUntil(()=>control.isEnabled(),'component writable');
    const check=async expectation=>{
     const node=output.surface.nodes.find(n=>n.id===expectation.id);assert.ok(node);
     const locator=node.type==='dynamicText'?surface.locator(`[data-ui-dynamic-text="${node.id}"]`):surface.getByText(node.label,{exact:true}).locator('..').locator('output');
     await waitUntil(async()=>{const text=(await locator.innerText()).trim();return expectation.number!==undefined?Math.abs(Number(text)-expectation.number)<=expectation.tolerance:expectation.pattern?new RegExp(expectation.pattern).test(text):text.includes(expectation.contains);},`independent result ${expectation.id}`);
    };
    for(const operation of spec.operations){
     await control.fill(String(operation.value));await control.press('Tab');
     for(const expectation of operation.expect)await check(expectation);
     await surface.getByText(/^(Saved · available to your next message|已保存 · 后续追问可读取当前参数)$/).waitFor();
     let saved;await waitUntil(async()=>{saved=await api(`/api/sessions/${original.sessionId}/answer-output?kind=intelligent-ui&toolCallId=${encodeURIComponent(output.toolCallId)}`);return saved.snapshot?.includes(`${input.label}: ${operation.value}`);},'disk snapshot records edited input');
     row.checkpoints.push({input:operation.value,expected:operation.expect,uiText:await surface.innerText(),saved});await persist();
    }
    await screenshot(`${spec.id}-operated.png`);await reload();await control.waitFor();
    await waitUntil(async()=>await control.inputValue()===String(spec.operations.at(-1).value),'input restored');
    for(const expectation of spec.operations.at(-1).expect)await check(expectation);
    row.reload='passed';await screenshot(`${spec.id}-restored.png`);
    const before=responses.length;currentPrompt=spec.followup;
    await page.locator('textarea').first().fill(currentPrompt);await page.getByRole('button',{name:/^(Send|发送)$/}).click();
    const followups=()=>responses.slice(before).filter(r=>r.caseId===spec.id&&r.purpose==='follow-up');
    await waitUntil(()=>{assert.ok(!followups().some(r=>r.status!==200),'Real provider follow-up failed');return followups().some(r=>r.text);},'real model response');
    await waitUntil(()=>page.getByRole('button',{name:/^(Send|发送)$/}).isVisible(),'follow-up settled');
    assert.ok(followups().every(r=>!r.tools?.length),'Explanation must not regenerate the component');
    const taskRequests=requests.filter(r=>r.caseId===spec.id&&r.purpose==='follow-up');
    const contexts=taskRequests.flatMap(r=>r.savedContext).map(text=>JSON.parse(text.slice(text.indexOf('\n')+1)));
    assert.ok(contexts.some(c=>c.surfaces?.some(s=>s.surfaceId===output.surface.id&&s.controls[spec.inputId]===spec.operations.at(-1).value)),'Real follow-up request contains exact edited and saved input');
    row.followup={prompt:spec.followup,answer:followups().map(r=>r.text??'').join('\n'),requestIds:taskRequests.map(r=>r.id),semanticReview:'pending-independent-human-review'};
    await screenshot(`${spec.id}-followup.png`);row.interaction='completed';row.status=row.semanticFindings.length?'semantic-failed':'completed';
   });}catch(error){row.status='failed';row.error=error.message;await screenshot(`${spec.id}-failure.png`).catch(()=>{});}
   assert.equal(sha(await readFile(path)),spec.sha256);await persist();
  }
  assert.ok(rows.every(row=>row.status==='completed'),'Recorded component task failed; inspect retained component-replay.json');
 },
};
const result=await runDesktopScenario({root,scenario,signal:cancel.signal,timeoutMs:1_200_000,stepTimeoutMs:90_000});
console.log(JSON.stringify({directory:result.directory,status:result.report.status,rows:rows.map(row=>({id:row.id,status:row.status,error:row.error})),cleanupErrors:result.report.cleanupErrors}));
if(result.report.status!=='passed')process.exitCode=1;
