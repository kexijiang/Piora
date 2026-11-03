import assert from "node:assert/strict";
import test from "node:test";
import { defaultPredictionSettings, validatePredictionSettings, predictionContext } from "./input-prediction.ts";
test("prediction is disabled by default and validates model and timeout", () => {
 assert.equal(defaultPredictionSettings().enabled,false);
 assert.throws(()=>validatePredictionSettings({enabled:true,model:{provider:"",modelId:"a"},timeoutMs:30000}));
 assert.throws(()=>validatePredictionSettings({enabled:true,model:null,timeoutMs:0}));
 assert.equal(validatePredictionSettings({enabled:true,model:{provider:"a",modelId:"b"},timeoutMs:5000}).timeoutMs,5000);
});
test("prediction keeps history and tool results but omits media bytes", () => {
 const context=predictionContext([{role:"user",content:"old request"},{role:"toolResult",content:[{type:"text",text:"tool output"},{type:"image",data:"base64"}]}]);
 assert.match(context,/old request/);assert.match(context,/tool output/);assert.doesNotMatch(context,/base64/);
});
