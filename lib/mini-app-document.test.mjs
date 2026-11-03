import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { compileMiniAppDocument, compileMiniAppCss, validateMiniAppAttribute } = await createJiti(import.meta.url).import("./mini-app/document.ts");
const compile = (html, css = "", options = { inputs: [], viewports: [] }) => compileMiniAppDocument({html,css},options);

test('priority suffix errors do not misidentify an otherwise supported CSS property',()=>{
  assert.ok(compileMiniAppCss('.row{display:flex;flex-direction:row}').includes('flex-direction:row'));
  assert.throws(()=>compileMiniAppCss('.row{flex-direction:row!important}'),error=>error.path==='document/css/flex-direction'
    &&error.message.includes('!important')&&!error.message.includes('Unsupported CSS property'));
});

test("document compiler preserves semantic layout, inputs, SVG bindings and viewports", () => {
  const document=compile(`<section class="board"><label for="amount">Amount</label><input id="amount" type="number" data-input="amount"><p data-text="result"></p><svg viewBox="0 0 400 200"><circle r="8" data-bind="cx:x;cy:y" data-event="drag"></circle></svg><div data-viewport="world"></div></section>`,
    `.board {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;color:var(--text)} @media (max-width: 600px){.board{display:block}}`, {inputs:["amount"],viewports:["world"]});
  assert.deepEqual(document.inputs,["amount"]);assert.deepEqual(document.viewports,["world"]);
  assert.deepEqual(document.bindings,[{id:"result"},{id:"x",attribute:"cx"},{id:"y",attribute:"cy"}]);
  assert.deepEqual(document.events,["drag"]);
  assert.equal(document.nodes[0].tag,"section");
});

test("HTML compilation rejects executable elements, URLs, handler attributes and foreign namespaces", () => {
  for(const html of ['<script>alert(1)</script>','<iframe src="https://example.com"></iframe>','<img src=x onerror=alert(1)>','<div onclick="alert(1)"></div>','<a href="https://example.com">go</a>','<svg><foreignObject><div>x</div></foreignObject></svg>','<svg><use href="#x"></use></svg>','<math><mtext>x</mtext></math>','<input type="file" data-input="file">']) {
    assert.throws(()=>compile(html),undefined,html);
  }
  const safe=compile('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(safe.nodes[0].children[0].text,'<script>alert(1)</script>');
});

test("CSS parsing rejects network resources, escape tricks, unbounded repetition and expensive rendering", () => {
  for(const css of ['@import "https://example.com/x";','div{background:url(https://example.com/x)}','div{background:u\\72l(x)}','div{animation:spin 1s infinite}','div{filter:blur(1000px)}','div{width:999999px}','div{font-size:100rem}','div{display:grid;grid-template-columns:repeat(99999,1fr)}','div{color:var(--anything)}','div{color:red!important}','div{background:image-set("x" 1x)}','div{position:fixed;inset:0}']) {
    assert.throws(()=>compileMiniAppCss(css),undefined,css);
  }
  assert.throws(()=>compile('<div style="color:red} body{background:blue"></div>'));
  assert.throws(()=>compileMiniAppCss('div{gap:var(--border)}'));
  assert.match(compileMiniAppCss('.card:hover{background-color:var(--bg-hover);padding:12px;color:#123456}'),/--bg-hover/);
});

test("pixel typography scales with host preferences without changing geometric dimensions", () => {
  const compiled = compileMiniAppCss('p{font-size:24px;width:240px}small{font-size:0.8em}h2{font-size:2rem}');
  assert.match(compiled, /font-size:1.5rem/);
  assert.match(compiled, /width:240px/);
  assert.match(compiled, /font-size:0.8em/);
  assert.equal(compileMiniAppCss(compiled), compiled);
  assert.match(compileMiniAppCss('button{font:inherit}'), /font:inherit/);
  assert.throws(() => compileMiniAppCss('button{font:16px serif}'));
  assert.match(compileMiniAppCss('h2{letter-spacing:0.02em;font-style:italic}'), /letter-spacing:0.02em/);
  assert.throws(() => compileMiniAppCss('h2{letter-spacing:100px}'));
  assert.throws(() => compileMiniAppCss('h2{word-spacing:2rem}'));
});

test("common semantic markup and bounded binding selectors preserve free layouts", () => {
  const document = compile('<main><header><h2>Steps</h2></header><section><i>Key</i><input data-input="count"></section><footer><code>Done</code></footer></main>', 'input[data-input]{width:8rem}[data-input="count"]:focus{color:var(--accent)}', { inputs: ['count'], viewports: [] });
  assert.equal(document.nodes[0].tag, 'main');
  assert.match(document.css, /input\[data-input\]/);
  for (const selector of ['[data-input^="x"]', '[data-unknown]', '[style]', '[data-input="two words"]', 'input::after', ':has(input)', '[data-input="x"]*']) {
    assert.throws(() => compileMiniAppCss(`${selector}{color:red}`), undefined, selector);
  }
});

test("binding and structure limits reject missing inputs, duplicates, replacement of nested content and oversized SVG", () => {
  assert.throws(()=>compile('<p>missing</p>', '', {inputs:['x'],viewports:[]}));
  assert.throws(()=>compile('<input data-input="x"><input data-input="x">','',{inputs:['x'],viewports:[]}));
  assert.throws(()=>compile('<p data-text="x"><strong>nested</strong></p>'));
  assert.throws(()=>compile('<div id="x"></div><div id="x"></div>'));
  assert.throws(()=>compile('<svg><circle data-bind="onclick:x"></circle></svg>'));
  assert.throws(()=>compile('<div>'.repeat(18)+'x'+'</div>'.repeat(18)));
  assert.throws(()=>validateMiniAppAttribute('d','M 0 0 '+ 'L 1 1 '.repeat(1000)));
  assert.throws(()=>validateMiniAppAttribute('fill','url(https://example.com)'));
  assert.throws(()=>validateMiniAppAttribute('transform','scale(100000)'));
  for (const d of ['L0 0','M0','M0 0 Z 1','M0 0 A1 1 0 2 0 2 2','M0 0 Q1 1 2']) assert.throws(()=>validateMiniAppAttribute('d',d));
  assert.throws(()=>validateMiniAppAttribute('points','1 2 3'));
  validateMiniAppAttribute('d','M0,0 L100,50 Q150,0 200,50 Z');
});
