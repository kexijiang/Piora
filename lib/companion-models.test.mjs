import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { validateCompanionGlb, listCompanionModels, readCompanionModelAsset, getCompanionModelsDirectory } = await jiti.import("./companion-models.ts");

function glb(document) {
  const json = Buffer.from(JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length/4)*4, " "));
  const bytes = Buffer.alloc(20 + json.length);
  bytes.write("glTF"); bytes.writeUInt32LE(2,4); bytes.writeUInt32LE(bytes.length,8);
  bytes.writeUInt32LE(json.length,12); bytes.write("JSON",16); json.copy(bytes,20);
  return bytes;
}

test("3D pets reject external textures, buffers, and malformed GLBs", () => {
  assert.doesNotThrow(() => validateCompanionGlb(glb({asset:{version:"2.0"},buffers:[{byteLength:0}]})));
  for (const document of [
    {asset:{version:"2.0"},images:[{uri:"https://example.com/private.png"}]},
    {asset:{version:"2.0"},buffers:[{uri:"file:///secret"}]},
    {asset:{version:"1.0"}}, null,
  ]) assert.throws(() => validateCompanionGlb(glb(document)));
  const invalid = glb({asset:{version:"2.0"}}); invalid.writeUInt32LE(1,8);
  assert.throws(() => validateCompanionGlb(invalid));
  assert.throws(() => validateCompanionGlb(Buffer.from("not a model")));
});

test("local 3D catalog isolates invalid packages and serves only fixed assets", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),"piora-models-"));
  t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
  const environment = {PI_CODING_AGENT_DIR:temp};
  const root = getCompanionModelsDirectory(environment);
  fs.mkdirSync(path.join(root,"jinx-3d"),{recursive:true});
  fs.writeFileSync(path.join(root,"jinx-3d","pet.json"), JSON.stringify({schemaVersion:1,renderer:"glb",id:"jinx-3d",displayName:"Jinx"}));
  fs.writeFileSync(path.join(root,"jinx-3d","model.glb"),glb({asset:{version:"2.0"}}));
  fs.writeFileSync(path.join(root,"jinx-3d","preview.png"),Buffer.from([137,80,78,71,13,10,26,10]));
  fs.mkdirSync(path.join(root,"broken"));
  const result = listCompanionModels(environment);
  assert.equal(result.pets.length,1);
  assert.equal(result.pets[0].model3d.url,"/api/companion-pets/jinx-3d/model");
  assert.equal(result.diagnostics[0].id,"broken");
  assert.ok(readCompanionModelAsset("jinx-3d","model.glb",environment).length);
  for (const id of ["../jinx-3d","CON","a/b"]) assert.throws(() => readCompanionModelAsset(id,"model.glb",environment));
});
