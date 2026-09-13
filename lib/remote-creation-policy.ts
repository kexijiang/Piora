import {realpathSync,statSync} from "node:fs";
import {isAbsolute,relative} from "node:path";
export interface RemoteCreationPolicy {allowedPolicies:Array<"notes"|"agent">;cwdRoots:string[]}
export function parseRemoteCreationPolicy(value:unknown):RemoteCreationPolicy {
  if(!value||typeof value!=="object")throw new Error("Invalid remote creation policy.");
  const policy=value as Partial<RemoteCreationPolicy>;
  if(!Array.isArray(policy.allowedPolicies)||policy.allowedPolicies.length>2||!policy.allowedPolicies.every(mode=>mode==="notes"||mode==="agent"))throw new Error("Invalid allowed session policies.");
  if(!Array.isArray(policy.cwdRoots)||policy.cwdRoots.length>16||!policy.cwdRoots.every(root=>typeof root==="string"&&root.length>0&&root.length<=32768&&isAbsolute(root)))throw new Error("Creation roots must be absolute paths (at most 16).");
  return {allowedPolicies:[...new Set(policy.allowedPolicies)],cwdRoots:[...new Set(policy.cwdRoots)]};
}
function directory(path:string):string {
  if(!isAbsolute(path))throw new Error("Creation cwd must be absolute.");
  const canonical=realpathSync(path);if(!statSync(canonical).isDirectory())throw new Error("Creation root must be a directory.");return canonical;
}
export function normalizeRemoteCreationPolicy(value:unknown):RemoteCreationPolicy {
  const policy=parseRemoteCreationPolicy(value);return {...policy,cwdRoots:[...new Set(policy.cwdRoots.map(directory))]};
}
export function resolveRemoteCreationCwd(policy:RemoteCreationPolicy|undefined,mode:"notes"|"agent",cwd:string):string {
  const canonical=directory(cwd);if(!policy)return canonical;
  if(!policy.allowedPolicies.includes(mode))throw new Error("The token does not allow this session policy.");
  const allowed=policy.cwdRoots.some(root=>{
    try{if(relative(root,directory(root))!=="")return false;const offset=relative(root,canonical);return offset===""||!isAbsolute(offset)&&offset!==".."&&!offset.startsWith("..\\")&&!offset.startsWith("../");}catch{return false;}
  });
  if(!allowed)throw new Error("The token does not allow this creation cwd.");return canonical;
}
