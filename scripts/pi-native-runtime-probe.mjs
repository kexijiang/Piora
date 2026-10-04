// Executed from an isolated production dependency tree, never from repo imports.
// Only the model response and a local MCP fixture are controlled.
export const piNativeRuntimeProbe = String.raw`
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.argv.includes('--mcp-fixture')) {
  createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line); if(message.id===undefined)return;
    const result=message.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'packaged-local-fixture',version:'1'}}:
      message.method==='tools/list'?{tools:[{name:'echo',description:'Isolated MCP probe',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]}:
      message.method==='tools/call'?{content:[{type:'text',text:message.params.arguments.value}],structuredContent:{verified:true}}:{};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  });
} else {
  const sdk=await import('@earendil-works/pi-coding-agent');
  const ai=await import('@earendil-works/pi-ai');
  const expected=['createMcpExtension','createCodemodeExtension','createToolSearchExtension','createAgentSessionServices','createAgentSessionFromServices','SessionManager','SettingsManager','ProjectTrustStore'];
  for(const name of expected)if(typeof sdk[name]!=='function')throw Error('Missing public SDK export '+name);
  for(const name of expected.slice(0,3))if(typeof sdk[name]({models:false})!=='function')throw Error('Invalid native factory '+name);
  const root=await mkdtemp(join(tmpdir(),'piora-packaged-native-'));
  const agentDir=join(root,'agent'); await mkdir(agentDir); process.env.PI_CODING_AGENT_DIR=agentDir;
  let session,request=0; const events=[];
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  try {
    const services=await sdk.createAgentSessionServices({cwd:root,agentDir,settingsManager:sdk.SettingsManager.create(root,agentDir),resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[
      {name:'packaged-native-mcp',replaceable:true,factory:sdk.createMcpExtension({logPath:join(agentDir,'mcp.log'),loadConfig:()=>({servers:[{name:'local',source:'packaged-controlled-fixture',scope:'global',config:{command:process.execPath,args:[fileURLToPath(import.meta.url),'--mcp-fixture'],exposure:'codemode'}}],errors:[]})})},
      {name:'packaged-native-codemode',replaceable:true,factory:sdk.createCodemodeExtension({models:false})},
      {name:'packaged-native-search',replaceable:true,factory:sdk.createToolSearchExtension()},
      pi=>pi.registerProvider('packaged-native-fixture',{api:'packaged-native-fixture',baseUrl:'https://unused.invalid',apiKey:'controlled-local-fixture',models:[{id:'model',name:'Local probe',reasoning:false,input:['text'],contextWindow:128000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple:model=>{
        const content=request++===0?[{type:'toolCall',id:'isolated-codemode',name:'codemode',arguments:{code:'text(await tools.mcp__local__echo({value:"PACKAGED_NATIVE_MCP_OK"})); text(typeof models);'}}]:[{type:'text',text:'done'}];
        const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,timestamp:Date.now(),usage,stopReason:request===1?'toolUse':'stop'};
        const stream=ai.createAssistantMessageEventStream(); queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message})}); return stream;
      }})
    ]}});
    ({session}=await sdk.createAgentSessionFromServices({services,sessionManager:sdk.SessionManager.create(root,join(agentDir,'sessions')),model:services.modelRuntime.getModel('packaged-native-fixture','model')}));
    session.setAutoRetryEnabled(false);session.setAutoCompactionEnabled(false);session.subscribe(event=>events.push(event));
    await session.bindExtensions({mode:'rpc'});await session.prompt('Run the isolated native MCP and worker probe');
    const result=events.find(event=>event.type==='tool_execution_end'&&event.toolName==='codemode');
    if(!result||result.isError||!JSON.stringify(result.result).includes('PACKAGED_NATIVE_MCP_OK')||!JSON.stringify(result.result).includes('undefined'))throw Error('Isolated native MCP/codemode failed: '+JSON.stringify(result));
    const nested=events.filter(event=>event.type==='tool_execution_start'&&event.toolName==='mcp__local__echo');
    if(nested.length!==1||nested[0].parentToolCallId!=='isolated-codemode')throw Error('MCP nested pipeline changed');
    console.log(JSON.stringify({nativeFactories:3,publicExports:expected,isolatedCodemode:true,localStdioMcp:true,modelGlobals:false,nestedPipeline:true}));
  } finally {if(session){await session.abort();await session.extensionRunner.emit({type:"session_shutdown",reason:"shutdown"});session.dispose()}await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
}
`;
