import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createJiti} from 'jiti';
import {prepareMiniAppRuntime} from './prepare-mini-app-runtime.mjs';

const root=resolve(import.meta.dirname,'..'),jiti=createJiti(import.meta.url);
const {MINI_APP_CAPABILITIES,MINI_APP_CAPABILITY_MANIFEST_VERSION}=await jiti.import('../lib/mini-app/capability-manifest.ts');
const tests=['lib/mini-app-capabilities.test.mjs','lib/mini-app-contract.test.mjs','lib/mini-app-generation.test.mjs','lib/mini-app-generation-runtime.test.mjs','lib/mini-app-admission.test.mjs','lib/mini-app-controller-browser.test.mjs','lib/mini-app-renderer-browser.test.mjs','lib/mini-app-worker-browser.test.mjs','lib/mini-app-runtime.test.mjs','lib/mini-app-restore-budget.test.mjs','lib/mini-app-document.test.mjs','lib/mini-app-frame.test.mjs','lib/mini-app-server-trial.test.mjs','lib/mini-app-repeat.test.mjs','lib/mini-app-repeat-browser.test.mjs','lib/mini-app-state.test.mjs'];
tests.push('lib/mini-app-scene.test.mjs','lib/mini-app-scene-browser.test.mjs');
tests.push('lib/mini-app-action-preview.test.mjs');
tests.push('lib/answer-output-client.test.mjs');
tests.push('lib/mini-app-groups.test.mjs','lib/mini-app-groups-browser.test.mjs');
tests.push('lib/mini-app-presets.test.mjs');
tests.push('lib/mini-app-migration.test.mjs','lib/mini-app-migration-browser.test.mjs','lib/mini-app-journal.test.mjs','lib/mini-app-inheritance.test.mjs','lib/mini-app-client-browser.test.mjs','lib/mini-app-route.test.mjs');
tests.push('lib/mini-app-progress-migration.test.mjs');
tests.push('lib/mini-app-migration-preview.test.mjs');
tests.push('lib/mini-app-authoring-repair.test.mjs','lib/mini-app-plan.test.mjs','lib/intelligent-ui-plan.test.mjs','lib/intelligent-ui-admission.test.mjs');
tests.push('lib/mini-app-input-ordering.test.mjs');
tests.push('lib/intelligent-ui/comparisons.test.mjs','lib/intelligent-ui/preview-plan.test.mjs');
tests.push('lib/mini-app-actions.test.mjs','lib/mini-app-actions-route.test.mjs','lib/mini-app-actions-browser.test.mjs',
 'lib/intelligent-ui/action-runtime.test.mjs','lib/intelligent-ui/action-route.test.mjs','lib/intelligent-ui/action-files.test.mjs','components/intelligent-ui-actions-browser.test.mjs');
tests.push('lib/mini-app-environment.test.mjs','lib/mini-app-environment-route.test.mjs','lib/mini-app-environment-browser.test.mjs','lib/prompt-run-registry.test.mjs','lib/agent-client.test.mjs');
tests.push('lib/rpc-manager-behavior.test.mjs');
tests.push('lib/answer-output-conversion-receipts.test.mjs','lib/answer-output-conversion.test.mjs','lib/answer-output-conversion-browser.test.mjs',
 'lib/intelligent-ui/generation-runtime.test.mjs','lib/intelligent-ui-generation.test.mjs','lib/intelligent-ui-generation-copy.test.mjs','lib/intelligent-ui/rich-plan.test.mjs');
const sources=[...new Set(MINI_APP_CAPABILITIES.flatMap(cap=>[...cap.sources]))].sort();
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const hashes=async files=>Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(join(root,file)))])));
await prepareMiniAppRuntime(root);
const verificationSources=[...sources,...tests,'lib/mini-app-migration-fixtures.mjs'];
const before=await hashes(verificationSources);
await mkdir(join(root,'.verification'),{recursive:true});
const run=await mkdtemp(join(root,'.verification','mini-app-capabilities-')),agent=await mkdtemp(join(tmpdir(),'piora-capability-agent-'));
console.log(JSON.stringify({run,scope:'isolated development capability verification',tests:tests.length}));
let output='';
try{
 const child=spawn(process.execPath,['--test','--test-concurrency=2',...tests],{cwd:root,windowsHide:true,env:{...process.env,NODE_ENV:'development',PI_CODING_AGENT_DIR:agent,PIORA_MINI_APP_CAPABILITIES:'development'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 const code=await new Promise((done,fail)=>{child.on('error',fail);child.on('close',done);});
 await writeFile(join(run,'tests.log'),output);
 if(code!==0)throw new Error('Capability checks failed; evidence was not promoted. Read '+join(run,'tests.log'));
 const after=await hashes(verificationSources);
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Sources changed during verification; evidence was not promoted');
 const verified=MINI_APP_CAPABILITIES.filter(cap=>['document','events','playback','svg','canvas2d','repeat','scene3d','scenePicking','cameraControls','sceneGroups','inputPresets','stateMigration','registeredActions','outputConversion'].includes(cap.id));
 const proof={manifestVersion:MINI_APP_CAPABILITY_MANIFEST_VERSION,recordedAt:new Date().toISOString(),entries:verified.map(cap=>({id:cap.id,version:cap.version,result:'passed',platform:process.platform,scope:'Deterministic SDK, QuickJS, headless Chromium/Edge and Controller fixtures; excludes natural task semantics, native window behavior and GPU compatibility',checks:tests,sources:Object.fromEntries(cap.sources.map(file=>[file,before[file]]))}))};
 await writeFile(join(root,'lib/mini-app/capability-evidence.json'),JSON.stringify(proof,null,2)+'\n');
 const {readMiniAppCapabilities}=await jiti.import('../lib/mini-app/capability-host.ts');
 const loaded=readMiniAppCapabilities();
 if(verified.some(cap=>loaded.capabilities.find(item=>item.id===cap.id)?.status!=='verified'))throw new Error('Host could not load the promoted proof; verification is incomplete');
 await writeFile(join(run,'result.json'),JSON.stringify({status:'passed',command:[process.execPath,'--test','--test-concurrency=2',...tests],sourceHashes:before,logSha256:sha(output),capabilities:verified.map(cap=>cap.id),scope:proof.entries[0].scope},null,2)+'\n');
 console.log(JSON.stringify({status:'passed',run,capabilities:verified.map(cap=>cap.id),summary:output.split('\n').filter(line=>/^ℹ (tests|pass|fail)/.test(line))}));
}finally{
 if(dirname(agent)!==resolve(tmpdir()))throw new Error('Unexpected capability test profile path');
 await rm(agent,{recursive:true,force:true});
}
