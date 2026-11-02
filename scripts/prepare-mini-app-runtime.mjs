import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";

const sourceRoot = resolve(import.meta.dirname, "..");

/** Bundles only first-party renderer code and pinned dependencies, never model code. */
export async function prepareMiniAppRuntime(root = sourceRoot, destination = resolve(root, ".mini-app-runtime")) {
  await mkdir(destination,{recursive:true});
  const release=await lockfile.lock(destination,{realpath:false,stale:120_000,update:10_000,retries:{retries:30,minTimeout:100,maxTimeout:1000}});
  try {return await buildRuntime(root,destination);}
  finally {await release();}
}

async function buildRuntime(root, destination) {
  const files = (await readdir(resolve(root,"lib/mini-app"))).filter(file=>file.endsWith(".ts")).sort();
  const require=createRequire(resolve(root,"package.json"));
  const wasmSource=require.resolve("quickjs-wasi/quickjs.wasm");
  const baseInputs=[...files.map(file=>`lib/mini-app/${file}`),relative(root,wasmSource).replaceAll('\\','/'),"package-lock.json","scripts/mini-app-typescript-loader.cjs","scripts/prepare-mini-app-runtime.mjs"];
  const fingerprintFor=async inputs=>{
    const hash=createHash("sha256");
    for(const file of inputs){hash.update(file);hash.update(await readFile(resolve(root,file)));}
    return hash.digest("hex");
  };
  const manifestPath=resolve(destination,"manifest.json"), outputPath=resolve(destination,"renderer.js"), workerPath=resolve(destination,"server-worker.cjs"), wasmPath=resolve(destination,"quickjs.wasm");
  try {
    const previous=JSON.parse(await readFile(manifestPath,"utf8"));
    if(!Array.isArray(previous.inputs)||previous.inputs.length>10_000||previous.inputs.some(file=>typeof file!=="string"||isAbsolute(file)||file.split(/[\\/]/).includes('..')))throw new Error("Invalid input manifest");
    const inputs=[...new Set([...baseInputs,...previous.inputs])].sort();
    const fingerprint=await fingerprintFor(inputs);
    const source=await readFile(outputPath);
    const worker=await readFile(workerPath);
    const wasm=await readFile(wasmPath);
    if(previous.fingerprint===fingerprint&&previous.sha256===createHash("sha256").update(source).digest("hex")&&previous.workerSha256===createHash("sha256").update(worker).digest("hex")&&previous.wasmSha256===createHash("sha256").update(wasm).digest("hex"))return {...previous,reused:true};
  } catch { /* A missing or modified asset is rebuilt from trusted source. */ }
  await mkdir(destination,{recursive:true});
  const { webpack }=require("next/dist/compiled/webpack/webpack.js");
  const compiler=webpack({ mode:"production",target:"web",devtool:false,entry:resolve(root,"lib/mini-app/renderer-runtime.ts"),
    output:{path:destination,filename:"renderer.js",iife:true},
    // Next's private production minifier is not a standalone webpack plugin.
    // Keep source/license comments; the bounded asset is fetched only on demand.
    optimization:{minimize:false},
    resolve:{extensions:[".ts",".js"],modules:[resolve(root,"node_modules"),"node_modules"]},
    module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:resolve(root,"scripts/mini-app-typescript-loader.cjs")}]},
    performance:{hints:false},
  });
  const rendererStats=await new Promise((done,fail)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done(stats))));
  const serverCompiler=webpack({mode:"production",target:"node",devtool:false,entry:resolve(root,"lib/mini-app/server-worker.ts"),
    output:{path:destination,filename:"server-worker.cjs"},optimization:{minimize:false},
    resolve:{extensions:[".ts",".js"],modules:[resolve(root,"node_modules"),"node_modules"]},
    module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:resolve(root,"scripts/mini-app-typescript-loader.cjs")}]},performance:{hints:false}});
  const workerStats=await new Promise((done,fail)=>serverCompiler.run((error,stats)=>serverCompiler.close(()=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done(stats))));
  const source=await readFile(outputPath);
  const worker=await readFile(workerPath);
  const wasm=await readFile(wasmSource);
  if(source.length>4*1024*1024||worker.length>4*1024*1024)throw new Error("Mini app runtime exceeds its asset budget");
  if(wasm.length>8*1024*1024)throw new Error("Mini app VM exceeds its asset budget");
  const dependencies=new Set(baseInputs);
  for(const file of [...rendererStats.compilation.fileDependencies,...workerStats.compilation.fileDependencies]){
    if(!(await stat(file)).isFile())continue;
    const local=relative(root,file).replaceAll('\\','/');
    if(isAbsolute(local)||local.split('/').includes('..'))throw new Error(`Mini app dependency is outside its build root: ${local}`);
    dependencies.add(local);
  }
  const inputs=[...dependencies].sort(),fingerprint=await fingerprintFor(inputs);
  await writeFile(wasmPath,wasm);
  const manifest={version:1,fingerprint,sha256:createHash("sha256").update(source).digest("hex"),bytes:source.length,
    workerSha256:createHash("sha256").update(worker).digest("hex"),workerBytes:worker.length,
    wasmSha256:createHash("sha256").update(wasm).digest("hex"),wasmBytes:wasm.length,inputs};
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n");
  return {...manifest,reused:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  prepareMiniAppRuntime().then(({inputs,...result})=>console.log(JSON.stringify({...result,inputCount:inputs.length}))).catch(error=>{console.error(error);process.exitCode=1;});
}
