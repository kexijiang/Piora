import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {intelligentUiRecovery} from './intelligent-ui-recovery.mjs';

export const intelligentUiSessionLifecycle={
  id:'intelligent-ui-session-lifecycle',mode:'local-model-fixture',
  scope:'Real development Electron/Next UI with the existing deterministic counter provider; transport failure fixture rejects PUT before persistence',
  coverage:['copy waits for pending state and reports failed saves','independent duplicate edits','fork inherits the selected branch checkpoint','HTML export waits for state and declares its static scope','subtree trash preserves pending descendant state','restore and independent continued editing'],
  limits:['real model semantics','native save dialog','native minimize/hide/restore','other platforms and release packages','complete migration/conversion/action combinations'],
  async prepare(context){
    await intelligentUiRecovery.prepare.call(this,context);
    context.report.fixture.transport='Synthetic 503 before a checkpoint PUT reaches persistence; no checkpoint or receipt is injected';
  },
  async run({page,step,waitUntil,reload,screenshot,directory}){
    const surface=page.locator('[data-mini-app-surface]').filter({has:page.getByRole('heading',{name:'Recovery counter',exact:true})});
    const frame=surface.frameLocator('iframe[title="Interactive answer"]');
    const count=value=>frame.locator('[data-text="count"]').filter({hasText:new RegExp('^'+value+'$')}).waitFor();
    const saved=()=>surface.getByText(/^(Saved · ready for your next message|已保存 · 后续追问可读取当前状态)$/).waitFor();
    const retained=async value=>{await surface.getByText(`Count: ${value}`,{exact:true}).waitFor();assert.equal(await surface.locator('iframe').count(),0,'Failed saves retain a static checkpoint until explicitly retried');};
    const retry=async value=>{await surface.getByRole('button',{name:/^(Retry|重试)$/}).click();await count(value);await saved();};
    const current=()=>new URL(page.url()).searchParams.get('session');
    const read=async path=>page.evaluate(async path=>{const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error(`Read ${path}: ${r.status}`);return r.json();},path);
    const output=id=>read(`/api/sessions/${id}/mini-app?toolCallId=recovery-create`);
    const row=title=>page.locator('.sidebar-session-row').filter({has:page.getByText(title,{exact:true})});
    const expand=async title=>{const button=row(title).locator('button[aria-expanded="false"]');if(await button.count())await button.click();};
    const menu=async(title,name)=>{await row(title).click({button:'right'});await page.getByRole('menuitem',{name}).click();};
    const rename=async title=>{
      await page.locator('.sidebar-session-row.is-selected').click({button:'right'});await page.getByRole('menuitem',{name:/^(Rename|重命名)$/}).click();
      const input=page.locator('.sidebar-session-row.is-selected input');await input.fill(title);await input.press('Enter');await row(title).waitFor();
    };
    const send=async()=>{await page.locator('textarea').first().fill('Recovery fixture: follow-up');await page.getByRole('button',{name:/^(Send|发送)$/}).click();};
    const save=async()=>{await surface.getByRole('button',{name:/^(Save|保存)$/}).click();await saved();await waitUntil(()=>surface.getByRole('button',{name:/^(Save|保存)$/}).isEnabled(),'save acknowledged');};
    const fault=enabled=>page.evaluate(enabled=>{window.__sessionCheckpointFailure=enabled;},enabled);
    const writes=[],copies=[],deletions=[],exports=[],observations=[],errors=[];
    page.on('response',response=>{
      const request=response.request(),path=new URL(request.url()).pathname;
      if(request.method()==='PUT'&&/\/mini-app$/.test(path))writes.push({path,status:response.status()});
      if(request.method()==='POST'&&/\/duplicate$/.test(path))void response.json().then(body=>copies.push({path,status:response.status(),body})).catch(e=>errors.push(e.message));
      if(request.method()==='DELETE'&&/\/api\/sessions\/[^/]+$/.test(path))deletions.push({path,status:response.status()});
      if(request.method()==='GET'&&/\/api\/sessions\/[^/]+\/export$/.test(path))void response.text().then(html=>exports.push({path,status:response.status(),html})).catch(e=>errors.push(e.message));
    });
    const record=async(label,ids)=>{const states={};for(const id of ids)states[id]=await output(id);observations.push({label,states});await writeFile(join(directory,'session-lifecycle-checkpoints.json'),JSON.stringify({observations,writes,copies,deletions,exportResponses:exports.map(({html,...r})=>({...r,bytes:Buffer.byteLength(html)})),errors},null,2));return states;};
    await step('enable-and-create',async()=>{
      await page.getByRole('button',{name:/^(Settings|设置)$/}).click();const dialog=page.getByRole('dialog',{name:/^(Settings|设置)$/});
      await dialog.getByRole('button',{name:/Beta Features/}).click();const toggle=dialog.getByRole('switch',{name:'Intelligent UI'});
      await waitUntil(()=>toggle.isEnabled(),'Beta loaded');if(!await toggle.isChecked())await toggle.click();await waitUntil(async()=>await toggle.isChecked()&&await toggle.isEnabled(),'Beta enabled');
      await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
      await page.locator('textarea').first().fill('Recovery fixture: create');await page.getByRole('button',{name:/^(Send|发送)$/}).click();
      await count(2);await saved();await page.getByText('Recovery fixture observed: Count: 2',{exact:true}).waitFor();
      await rename('Lifecycle original');
    });
    const original=current();assert.ok(original);let duplicate,fork;
    await step('install-save-failure-fixture',async()=>{
      await page.evaluate(()=>{const original=window.fetch;window.__sessionCheckpointFailure=true;
        window.fetch=async(input,init)=>{
          const request=new Request(input,init);
          if(window.__sessionCheckpointFailure&&request.method==='PUT'&&/\/api\/sessions\/[^/]+\/mini-app$/.test(new URL(request.url).pathname)){
            return Response.json({error:{code:'IO',message:'Session lifecycle fixture: checkpoint unavailable'}},{status:503});
          }
          return original.call(window,input,init);
        };
      });
    });
    await step('failed-save-blocks-copy',async()=>{
      await frame.getByLabel('Starting value').fill('9');await count(9);
      await menu('Lifecycle original',/^(Duplicate task|复制任务)$/);
      await page.getByRole('alert').filter({hasText:/Could not duplicate task|复制任务失败/}).waitFor();
      assert.equal(copies.length,0);assert.equal((await output(original)).result.snapshot.state.count,2);
      await retained(9);await screenshot('lifecycle-copy-blocked.png');
    });
    await step('copy-retries-pending-checkpoint',async()=>{
      await fault(false);await retry(9);await frame.getByLabel('Starting value').fill('10');await count(10);await menu('Lifecycle original',/^(Duplicate task|复制任务)$/);
      await waitUntil(()=>copies.length===1,'one acknowledged copy');assert.equal(copies[0].status,200);duplicate=copies[0].body.sessionId;assert.ok(duplicate);
      const states=await record('copied-current-state',[original,duplicate]);
      assert.equal(states[original].result.snapshot.state.count,10);assert.deepEqual(states[duplicate].result.snapshot,states[original].result.snapshot);
      await expand('Lifecycle original');
      await row('Lifecycle original copy').click();await waitUntil(()=>current()===duplicate,'duplicate selected');await count(10);await rename('Lifecycle copy');
      await frame.getByRole('button',{name:'Add one'}).click();await count(11);await save();
      assert.equal((await output(original)).result.snapshot.state.count,10);
    });
    await step('fork-keeps-branch-visible-state',async()=>{
      await send();await page.getByText('Recovery fixture observed: Count: 11',{exact:true}).waitFor();
      // The fork excludes this user question and its reply. A subsequent edit
      // belongs to the newer branch and must not leak into the older fork.
      await frame.getByRole('button',{name:'Add one'}).click();await count(12);await save();
      const question=page.locator('.message-row-user').filter({hasText:'Recovery fixture: follow-up'}).last();
      await question.hover();await question.getByRole('button',{name:/^(New session|新会话)$/}).click();
      await waitUntil(()=>!!current()&&current()!==duplicate,'fork selected');fork=current();await count(11);await rename('Lifecycle fork');
      const states=await record('independent-fork',[original,duplicate,fork]);
      assert.equal(states[original].result.snapshot.state.count,10);assert.equal(states[duplicate].result.snapshot.state.count,12);assert.equal(states[fork].result.snapshot.state.count,11);
    });
    const openExport=async()=>{await page.getByRole('button',{name:/^(Full history|完整历史)$/}).click();const history=page.locator('[data-history-workbench]');await history.getByRole('button',{name:/^(Export|导出)$/}).click();await history.getByRole('button',{name:/^(Complete conversation HTML|完整会话 HTML)$/}).click();return history;};
    const back=()=>page.locator('[data-history-workbench]').getByRole('button',{name:/^(Back to conversation|返回对话)$/}).click();
    await step('failed-save-blocks-export',async()=>{
      await fault(true);await frame.getByLabel('Starting value').fill('12');await count(12);
      const history=await openExport();await history.getByRole('alert').waitFor();assert.equal(exports.length,0);assert.equal((await output(fork)).result.snapshot.state.count,11);
      await back();await retained(12);
    });
    await step('export-confirms-state-and-static-scope',async()=>{
      await fault(false);await retry(12);
      const downloads=join(directory,'downloads');await mkdir(downloads);
      const cdp=await page.context().newCDPSession(page);
      try{await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
        await openExport();await waitUntil(()=>exports.length===1,'HTML export response');assert.equal(exports[0].status,200);
        assert.match(exports[0].html,/Current branch snapshot; interactive controls require Piora/);assert.match(exports[0].html,/Count: 12/);
        const file=join(downloads,`piora-history-${fork}.html`);
        await waitUntil(async()=>{try{return (await readFile(file,'utf8')).includes('Count: 12');}catch{return false;}},'downloaded HTML contains confirmed state');
      }finally{await cdp.detach();}
      assert.equal((await output(fork)).result.snapshot.state.count,12);await back();await count(12);await screenshot('lifecycle-exported.png');
    });
    const trashCopy=async()=>{await menu('Lifecycle copy',/^(Delete|删除)$/);const dialog=page.getByRole('dialog',{name:/^(Move conversation to recycle bin\?|移入回收站？)$/});await dialog.getByRole('button',{name:/^(Delete|删除)$/}).click();};
    await step('failed-descendant-save-blocks-subtree-trash',async()=>{
      await fault(true);await frame.getByLabel('Starting value').fill('13');await count(13);await trashCopy();
      await row('Lifecycle copy').getByRole('alert').waitFor();assert.equal(deletions.length,0);assert.equal((await output(fork)).result.snapshot.state.count,12);await retained(13);
    });
    await step('trash-retry-preserves-descendant',async()=>{
      await fault(false);await retry(13);await trashCopy();await waitUntil(()=>deletions.length===1,'subtree deletion acknowledged');assert.equal(deletions[0].status,200);
      await row('Lifecycle copy').waitFor({state:'hidden'});await row('Lifecycle fork').waitFor({state:'hidden'});
      const trash=await read('/api/sessions/trash'),item=trash.sessions.find(item=>item.id===duplicate);assert.ok(item);assert.equal(item.count,2);
      assert.equal((await output(original)).result.snapshot.state.count,10);await screenshot('lifecycle-trashed.png');
    });
    await step('restore-subtree-and-continue',async()=>{
      await page.getByRole('button',{name:/^(Settings|设置)$/}).click();const dialog=page.getByRole('dialog',{name:/^(Settings|设置)$/});
      await dialog.getByRole('button',{name:/^(Recycle bin|回收站)$/}).click();
      await dialog.locator('article').filter({hasText:'Lifecycle copy'}).getByRole('button',{name:/^(Restore|恢复)$/}).click();
      await dialog.getByRole('link',{name:/^(Open conversation|打开会话)$/}).waitFor();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
      await expand('Lifecycle original');
      await row('Lifecycle copy').click();await waitUntil(()=>current()===duplicate,'restored copy selected');await count(12);
      await expand('Lifecycle copy');
      await row('Lifecycle fork').click();await waitUntil(()=>current()===fork,'restored fork selected');await count(13);
      await reload();await count(13);await frame.getByRole('button',{name:'Add one'}).click();await count(14);await save();
      await send();await page.getByText('Recovery fixture observed: Count: 14',{exact:true}).waitFor();
      const states=await record('restored-and-continued',[original,duplicate,fork]);
      assert.equal(states[original].result.snapshot.state.count,10);assert.equal(states[duplicate].result.snapshot.state.count,12);assert.equal(states[fork].result.snapshot.state.count,14);
      assert.deepEqual(errors,[]);await screenshot('lifecycle-restored.png');
    });
  },
};
