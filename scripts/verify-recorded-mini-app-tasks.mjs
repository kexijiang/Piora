import assert from 'node:assert/strict';
import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {getAgentDir,ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createJiti} from 'jiti';
import {runDesktopScenario} from './desktop-e2e/harness.mjs';
import {startRealModelProxy} from './desktop-e2e/real-model-proxy.mjs';

// Bindings describe how to address an untouched generated artifact. Expected
// results are independent task oracles, never computed from its program.
const root=process.cwd(),args=process.argv.slice(2);
const jiti=createJiti(import.meta.url);
const {ANSWER_FORM_POLICY_VERSION,ANSWER_FORM_GUIDELINES}=await jiti.import('../lib/answer-output-decision.ts');
const {MINI_APP_INSPECTION_GUIDANCE}=await jiti.import('../lib/mini-app/action-inspection.ts');
assert.ok(args.includes('--bindings'),'Explicit --bindings <json> is required');
const bindingsPath=resolve(args[args.indexOf('--bindings')+1]);
const bindings=JSON.parse(await readFile(bindingsPath,'utf8'));
assert.equal(bindings.version,1);assert.ok(bindings.cases.length>0);
const thinking=bindings.thinking??'disabled';assert.ok(['enabled','disabled'].includes(thinking));
const onDemand=bindings.actionEvidenceMode==='on-demand';
assert.ok(bindings.actionEvidenceMode===undefined||onDemand,'Unknown action evidence contract');
const sha=value=>createHash('sha256').update(value).digest('hex');
const samples=await Promise.all(bindings.cases.map(async spec=>{
  const path=resolve(spec.source),bytes=await readFile(path),original=JSON.parse(bytes);
  assert.equal(sha(bytes),spec.sha256,'Binding must identify the exact original report');
  assert.equal(original.status,'completed');
  const record=original.journal.records.find(r=>r.status==='committed');assert.ok(record);
  return {spec,path,original,record};
}));
const cancel=new AbortController();for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>cancel.abort(new Error(event)));
const userAgent=getAgentDir(),runtime=await ModelRuntime.create({authPath:join(userAgent,'auth.json'),modelsPath:join(userAgent,'models.json'),allowModelNetwork:false});
const model=runtime.getModel('deepseek','deepseek-flash');
assert.ok(model&&/V4\.1/.test(model.name)&&runtime.hasConfiguredAuth('deepseek'),'Configured DeepSeek V4.1 Flash, without fallback, is required');
let directory,currentCase,currentPrompt;
const rows=[],requests=[],responses=[];
const persist=()=>writeFile(join(directory,'task-replay.json'),JSON.stringify({
  version:1,bindings:bindingsPath,scope:'Untouched generated programs replayed on the current isolated Windows development desktop. UI operations with independent expected task states, disk verification and real-model follow-up. Not new generation or human semantic acceptance.',
  configuredModel:{provider:model.provider,id:model.id,name:model.name,thinking,fallback:false},rows,requests,responses,
},null,2)+'\n');
const parts=m=>typeof m.content==='string'?[m.content]:(m.content??[]).filter(b=>b.type==='text').map(b=>b.text);
const at=(value,path)=>path.split('.').reduce((v,key)=>v?.[key],value);
const scenario={
  id:'recorded-mini-app-tasks',mode:'original-generation-live-followup',
  scope:'Original SDK transcripts and mini-app journals copied to an isolated development profile; no program edits or API-driven task operations',
  coverage:['independent task trajectories','trusted UI operations','saved checkpoint','reload and continuation','real pinned model follow-up'],
  limits:['new generation','two-human semantic review','other platforms','release packages','full recovery matrix'],
  async prepare(context){
    directory=context.directory;context.report.recordings=samples.map(({spec})=>({id:spec.id,source:spec.source,sha256:spec.sha256}));
    context.report.credentials='Memory-only real-provider relay; profile contains only a disposable loopback token';
    for(const {path} of samples){
      const source=join(dirname(path),'agent');
      await cp(join(source,'sessions'),join(context.paths.agent,'sessions'),{recursive:true,force:false,errorOnExist:true});
      for(const name of ['intelligent-ui','mini-app']){
        const destination=join(context.paths.agent,'piora',name);await mkdir(destination,{recursive:true});
        for(const file of await readdir(join(source,'piora',name)))if(file.endsWith('.json'))
          await cp(join(source,'piora',name,file),join(destination,file),{force:false,errorOnExist:true});
      }
    }
    await writeFile(join(context.paths.agent,'piora','beta-features.json'),JSON.stringify({version:1,intelligentUi:true}));
    const relay=await startRealModelProxy({runtime,model,signal:context.signal,registerCleanup:context.registerCleanup,
      onRequest:async({id,body})=>{
        assert.equal(body.model,'deepseek-flash');
        const texts=(body.messages??[]).flatMap(parts),purpose=currentPrompt&&texts.includes(currentPrompt)?'follow-up':'background';
        if(purpose==='follow-up')assert.equal(body.thinking?.type,thinking,'Inspect actual request, not just UI configuration');
        const promptIndex=(body.messages??[]).findLastIndex(message=>parts(message).includes(currentPrompt));
        const followupMessages=promptIndex>=0?body.messages.slice(promptIndex+1):[];
        const system=(body.messages??[]).filter(message=>['system','developer'].includes(message.role)).flatMap(parts).join('\n');
        const policy={version:ANSWER_FORM_POLICY_VERSION,shared:ANSWER_FORM_GUIDELINES.map(rule=>system.includes(rule)),inspection:system.includes(MINI_APP_INSPECTION_GUIDANCE),systemCharacters:system.length,
          tools:(body.tools??[]).map(tool=>tool.function?.name)};
        if(purpose==='follow-up'&&onDemand){assert.ok(policy.shared.every(Boolean),'Actual provider request carries every current shared scope rule');assert.ok(policy.inspection,'Actual provider request carries inspection guidance');assert.ok(policy.tools.includes('piora_inspect_mini_app'));}
        requests.push({id,caseId:currentCase,purpose,model:body.model,thinking:body.thinking,at:new Date().toISOString(),
          policy,
          savedContext:texts.filter(text=>/^Saved (?:interactive UI|mini app) parameters and host publication results/.test(text)),
          inspectionResults:followupMessages.filter(message=>message.role==='tool').flatMap(parts).filter(text=>text.startsWith('Read-only local action observations follow')),
          followupToolCalls:followupMessages.flatMap(message=>message.tool_calls??[]).map(call=>({id:call.id,name:call.function?.name,arguments:call.function?.arguments})),
          digest:sha(JSON.stringify(body))});await persist();
      },
      onResponse:async response=>{const request=requests.find(r=>r.id===response.id);responses.push({...response,caseId:request?.caseId,purpose:request?.purpose});await persist();},
    });
    await writeFile(join(context.paths.agent,'models.json'),JSON.stringify({providers:{deepseek:{api:model.api,...relay,
      models:[{id:model.id,name:model.name,reasoning:model.reasoning,compat:model.compat,input:['text'],contextWindow:model.contextWindow,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    }}}));
    await writeFile(join(context.paths.agent,'settings.json'),JSON.stringify({packages:[],extensions:[],skills:[],retry:{enabled:false},defaultProvider:model.provider,defaultModel:model.id,enabledModels:[`${model.provider}/${model.id}`],defaultThinkingLevel:thinking==='enabled'?'medium':'off'}));
    await persist();
  },
  async run({page,origin,step,waitUntil,reload,screenshot}){
    const api=async path=>{
      const r=await page.evaluate(async path=>{const r=await fetch(path,{cache:'no-store'});return {status:r.status,data:await r.json()};},path);
      assert.equal(r.status,200);return r.data;
    };
    for(const {spec,original,record} of samples){
      currentCase=spec.id;currentPrompt=undefined;
      const row={id:spec.id,source:spec.source,sha256:spec.sha256,status:'running',checkpoints:[],semanticFindings:[...(spec.findings??[])],semanticReview:'pending-independent-human-review'};
      rows.push(row);await persist();
      try{await step(spec.id,async()=>{
        await page.goto(`${origin}/?session=${encodeURIComponent(original.sessionId)}`,{waitUntil:'domcontentloaded'});
        const surface=page.locator('[data-mini-app-surface]').first(),frame=surface.frameLocator('iframe[title="Interactive answer"]');
        const healthy=async()=>{
          for(const name of ['runtime','state','action'])assert.ok(!await surface.getAttribute(`data-mini-app-${name}-error`),`Host ${name} error`);
        };
        const ready=()=>waitUntil(async()=>{if(!await surface.count())return false;await healthy();return frame.locator(spec.readySelector).isVisible();},'recorded mini app ready');
        const pointerPoint=async operation=>{
          const target=frame.locator(operation.space);
          await target.scrollIntoViewIfNeeded();
          const box=await target.boundingBox();assert.ok(box,'Pointer coordinate space must be visible');
          const points=await target.evaluate((node,{from,to,size})=>{
            const bounds=node.getBoundingClientRect();
            const point=([x,y])=>{
              if(node instanceof SVGSVGElement){
                const matrix=node.getScreenCTM();if(!matrix)throw new Error('SVG transform is unavailable');
                const transformed=new DOMPoint(x,y).matrixTransform(matrix);
                return {x:transformed.x-bounds.x,y:transformed.y-bounds.y};
              }
              if(!(node instanceof HTMLCanvasElement)||!size)throw new Error('Explicit canvas coordinate size is required');
              return {x:x*bounds.width/size.width,y:y*bounds.height/size.height};
            };
            return [point(from),point(to)];
          },operation);
          return points.map(p=>({x:box.x+p.x,y:box.y+p.y}));
        };
        const assertUi=async(expectations,patterns)=>{
          for(const [selector,expected] of Object.entries(expectations??{}))await waitUntil(async()=>{
            await healthy();const locator=frame.locator(selector);return await locator.count()===1&&(await locator.innerText()).trim()===String(expected);
          },`UI value ${selector}`);
          for(const [selector,pattern] of Object.entries(patterns??{}))await waitUntil(async()=>{
            await healthy();const locator=frame.locator(selector);
            return await locator.count()===1&&new RegExp(pattern).test((await locator.innerText()).trim());
          },`UI text ${selector}`);
        };
        const save=async()=>{
          await healthy();const button=surface.getByRole('button',{name:/^(Save|保存)$/});await button.click();
          await waitUntil(async()=>{await healthy();return surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).isVisible()&&await button.isEnabled();},'saved checkpoint acknowledged');
          return api(`/api/sessions/${original.sessionId}/mini-app?toolCallId=${encodeURIComponent(record.toolCallId)}`);
        };
        await ready();await screenshot(`${spec.id}-initial.png`);
        for(const [index,operation] of spec.operations.entries()){
          if(operation.kind==='click')await frame.locator(operation.selector).click();
          else if(operation.kind==='key')await frame.locator(operation.selector).press(operation.key);
          else if(operation.kind==='select')await frame.locator(operation.selector).selectOption(operation.value);
          else if(operation.kind==='drag'){
            const [from,to]=await pointerPoint(operation);
            await page.mouse.move(from.x,from.y);await page.mouse.down();
            try{await page.mouse.move(to.x,to.y,{steps:8});}finally{await page.mouse.up();}
          }
          else if(operation.kind==='host')await surface.getByRole('button',{name:new RegExp(operation.name)}).click();
          else if(operation.kind==='reload')await reload();
          else throw new Error(`Unknown fixture operation ${operation.kind}`);
          await ready();await assertUi(operation.ui,operation.uiPatterns);
          const saved=await save();
          const checkpoint={index,operation:operation.kind,saved,uiText:await frame.locator('body').innerText()};
          row.checkpoints.push(checkpoint);await persist();
          for(const [path,expected] of Object.entries(operation.expected??{}))assert.deepEqual(at(saved.result,path),expected,`Independent oracle at ${index}: ${path}`);
          for(const check of operation.proseChecks??[]){
            const actual=String(at(saved.result,check.path));
            if(!new RegExp(check.pattern).test(actual))row.semanticFindings.push({index,path:check.path,expected:check.explanation,actual});
          }
          if(operation.sameAs!==undefined)assert.deepEqual(saved.result.snapshot,row.checkpoints[operation.sameAs].saved.result.snapshot,`Checkpoint preserved at ${index}`);
          checkpoint.status='passed';await persist();
        }
        await screenshot(`${spec.id}-operated.png`);
        const saved=row.checkpoints.at(-1).saved,before=responses.length;
        currentPrompt=spec.followup;
        await page.locator('textarea').first().fill(currentPrompt);await page.getByRole('button',{name:/^(Send|发送)$/}).click();
        const followups=()=>responses.slice(before).filter(r=>r.caseId===spec.id&&r.purpose==='follow-up');
        await waitUntil(()=>{assert.ok(!followups().some(r=>r.status!==200),'Real model follow-up failed');return followups().some(r=>r.text&&r.finishReasons?.includes('stop'));},'real model final response');
        await waitUntil(()=>page.getByRole('button',{name:/^(Send|发送)$/}).isVisible(),'follow-up settled');
        await waitUntil(async()=>await page.locator('[data-answer-output-interaction-paused]').count()===0,'follow-up state synchronization settled');
        const taskRequests=requests.filter(r=>r.caseId===spec.id&&r.purpose==='follow-up');
        const calls=[...new Map(taskRequests.flatMap(request=>request.followupToolCalls).map(call=>[call.id,call])).values()];
        if(onDemand){
          assert.ok(calls.every(call=>call.name==='piora_inspect_mini_app'),'Explanation may only inspect saved local effects, never regenerate or perform external actions');
          if(spec.expectInspection===false)assert.equal(calls.length,0,'Current-state question needs no inspection');
          if(spec.expectInspection===true)assert.ok(calls.length>0,'Requested future effects must be inspected');
        }else assert.ok(followups().every(r=>!r.tools?.length),'Explanation must preserve the existing app');
        const contexts=taskRequests.flatMap(r=>r.savedContext).map(text=>JSON.parse(text.slice(text.indexOf('\n')+1)));
        assert.ok(contexts.some(c=>c.apps?.some(app=>app.id===record.plan.id&&!Object.hasOwn(app,'tick')&&app.runtimeMetadata?.tick===saved.result.snapshot.tick&&app.runtimeMetadata?.playbackMode===(record.plan.playback?.mode??'legacy')&&app.summary===saved.result.frame.summary.slice(0,2000))),'Real request includes the exact saved summary and separately labelled host clock');
        const actionEvidence=onDemand?[...new Set(taskRequests.flatMap(request=>request.inspectionResults))].map(text=>JSON.parse(text.slice(text.indexOf('\n')+1)))
          :[contexts.flatMap(c=>c.apps??[]).find(app=>app.id===record.plan.id)?.localActionPreviews];
        if(onDemand)assert.ok(contexts.flatMap(c=>c.apps??[]).every(app=>!app.localActionPreviews),'Default saved-state messages contain no executed alternatives');
        const checkedActions=new Set();
        if(spec.actionPreviews||spec.actionChanges)for(const evidence of actionEvidence){
          assert.ok(evidence&&!evidence.unavailable,'Real request includes local VM action evidence');
          assert.equal(evidence.source.planDigest,saved.publication.planDigest);assert.equal(evidence.source.stateRevision,saved.stateRevision);
          if(onDemand){
            assert.equal(evidence.appId,record.plan.id);
            assert.ok(calls.some(call=>{const args=JSON.parse(call.arguments);return args.appId===evidence.appId&&JSON.stringify(args.actionIds)===JSON.stringify(evidence.requestedActionIds);}), 'Inspection corresponds to an actual model request');
            for(const action of evidence.actions){assert.ok(evidence.requestedActionIds.includes(action.id));assert.ok(Object.hasOwn(spec.actionChanges??{},action.id)||Object.hasOwn(spec.actionPreviews??{},action.id),'Every inspected action has an independent oracle');}
          }
          for(const action of evidence.actions)checkedActions.add(action.id);
          for(const [id,expected] of Object.entries(spec.actionPreviews??{})){
            if(onDemand&&!evidence.actions.some(action=>action.id===id))continue;
            const action=evidence.actions.find(action=>action.id===id);assert.ok(action,`Preview ${id} is present`);assert.equal(action.status,'ok');
            for(const [path,value] of Object.entries(expected))assert.deepEqual(at(action,path),value,`Independent preview oracle ${id}: ${path}`);
          }
          for(const [id,expected] of Object.entries(spec.actionChanges??{})){
            if(onDemand&&!evidence.actions.some(action=>action.id===id))continue;
            assert.equal(evidence.version,2);
            const action=evidence.actions.find(action=>action.id===id);assert.ok(action,`Preview ${id} is present`);assert.equal(action.status,'ok');
            for(const [path,values] of Object.entries(expected)){
              const parts=path.slice(1).split('/').map(key=>key.replaceAll('~1','/').replaceAll('~0','~'));
              assert.deepEqual(parts.reduce((value,key)=>value?.[key],saved.result.snapshot),values.before,`Independent preview baseline ${id}: ${path}`);
              const change=action.changes.items.find(item=>item.path===path);
              if(change){assert.equal(change.kind,'replace');assert.deepEqual(change.before,values.before);assert.deepEqual(change.after,values.after,`Independent transition ${id}: ${path}`);}
              else {assert.equal(action.changes.complete,true,'Only exhaustive differences prove an unlisted field unchanged');assert.deepEqual(values.before,values.after,`Expected changed field is missing: ${id} ${path}`);}
            }
          }
          for(const path of spec.fieldEffectPaths??[]){
            const field=evidence.fieldEffects?.fields.find(field=>field.path===path);
            assert.ok(field,`Field effects include ${path}`);
            for(const [actionId,changes] of Object.entries(spec.actionChanges??{})){
              if(onDemand&&!evidence.actions.some(action=>action.id===actionId))continue;
              const expected=changes[path];if(!expected)continue;
              assert.deepEqual(field.current,expected.before,`Field baseline ${actionId}: ${path}`);
              assert.ok(!field.unknown.includes(actionId),`Field result is known: ${actionId} ${path}`);
              if(expected.before===expected.after)assert.ok(field.unchanged.includes(actionId),`Preserved field: ${actionId} ${path}`);
              else {
                assert.ok(!field.unchanged.includes(actionId));
                const outcome=field.outcomes.find(outcome=>outcome.actions.includes(actionId));
                assert.ok(outcome?.present,`Present field: ${actionId} ${path}`);
                assert.deepEqual(outcome.value,expected.after,`Field result ${actionId}: ${path}`);
              }
            }
          }
        }
        for(const id of spec.expectedInspectionActions??[])assert.ok(checkedActions.has(id),`Requested action ${id} was inspected and independently checked`);
        row.actionPreviews=onDemand?actionEvidence:actionEvidence[0];row.inspectionCalls=calls;
        const afterFollowup=await api(`/api/sessions/${original.sessionId}/mini-app?toolCallId=${encodeURIComponent(record.toolCallId)}`);
        assert.deepEqual(afterFollowup.result.snapshot,saved.result.snapshot,'Explanation and read-only preview preserve saved progress');
        assert.equal(afterFollowup.stateRevision,saved.stateRevision,'Explanation does not write a new state revision');
        row.followup={prompt:spec.followup,answer:followups().map(r=>r.text??'').join('\n'),requestIds:taskRequests.map(r=>r.id),semanticReview:'pending-independent-human-review'};
        await screenshot(`${spec.id}-followup.png`);row.interaction='completed';row.status=row.semanticFindings.length?'semantic-failed':'completed';await persist();
      });}catch(error){row.status='failed';row.error=error.message;await screenshot(`${spec.id}-failure.png`).catch(()=>{});}
      await persist();
    }
    for(const {path,spec} of samples)assert.equal(sha(await readFile(path)),spec.sha256,'Original evidence must remain unchanged');
    assert.ok(rows.every(r=>r.status==='completed'),'Recorded task failed; inspect task-replay.json');
  },
};
const result=await runDesktopScenario({root,scenario,signal:cancel.signal,timeoutMs:1_200_000,stepTimeoutMs:120_000});
console.log(JSON.stringify({directory:result.directory,status:result.report.status,rows:rows.map(r=>({id:r.id,status:r.status,error:r.error})),cleanupErrors:result.report.cleanupErrors}));
if(result.report.status!=='passed')process.exitCode=1;
