import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),executable=require('electron');
const root=await mkdtemp(path.join(tmpdir(),'piora-auth-test-'));
const server=createServer((req,res)=>{
 res.setHeader('Content-Type','text/html');
 if(req.url==='/login'){res.setHeader('Set-Cookie','fixture_login=fixture-token; HttpOnly; SameSite=Lax; Path=/');res.end('<html><body>Login fixture</body></html>');}
 else if(req.url==='/popup'){assert.equal(req.method,'POST');res.end(`<script>window.opener.postMessage('login-complete',location.origin);window.close();</script>`);}
 else res.end(req.headers.cookie?.includes('fixture_login=fixture-token')?'signed-in':'signed-out');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 for(const phase of ['save','restore']) await new Promise((resolve,reject)=>{
  const env={...process.env,PIORA_BROWSER_TEST_HOME:root,PIORA_BROWSER_TEST_URL:'http://127.0.0.1:'+server.address().port,PIORA_BROWSER_TEST_PHASE:phase};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,['scripts/browser-auth-fixture.cjs'],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',v=>{stdout+=v;});child.stderr.on('data',v=>stderr+=v);
  const timeout=setTimeout(()=>{child.kill();reject(new Error('Electron verification timed out: '+stderr));},40000);
  child.on('exit',code=>{clearTimeout(timeout);if(code)reject(new Error(stdout+stderr));else{console.log(stdout.trim());resolve();}});
 });
}finally{
 server.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('piora-auth-test-'));
 await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
