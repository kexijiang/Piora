// Apache-2.0; ported from dsh-harmoneydev-tools, see third_party/harmony-log-workbench/SOURCE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLogLibrary } from '../vendor/log-library.mjs';
async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'dsh-session-search-')), library=createLogLibrary(root);
  try { await run(library); } finally { await library.dispose();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.startsWith(join(tmpdir(),'dsh-session-search-')));await rm(root,{recursive:true,force:true}); }
}
async function upload(library,sessionId,name,text) {
  const scope={sessionId},bytes=Buffer.from(text),file=await library.begin({name,size:bytes.length},scope);
  await library.chunk(file.id,0,bytes,scope);return library.finish(file.id,scope);
}
test('session-wide search scans bodies across files, preserves original lines and does not leak another session',()=>fixture(async library=>{
  const first=await upload(library,'A','one.log','normal\n\nTARGET one\nTARGET two\n');
  await upload(library,'A','two.log','TARGET three\nno\n');await upload(library,'B','secret.log','TARGET secret\n');
  const result=await library.search({query:'target',limit:100},{sessionId:'A'});
  assert.equal(result.filteredTotal,3);assert.equal(result.matchedFiles,2);assert.equal(result.searchedFiles,2);assert.equal(result.sessionId,'A');
  assert.deepEqual(result.entries.filter(row=>row.fileId===first.id).map(row=>row.sourceLine),[3,4]);
  assert.ok(result.entries.every(row=>row.fileName!=='secret.log'));assert.equal(result.nextOffset,null);
  assert.equal((await library.search({query:'target',caseSensitive:true},{sessionId:'A'})).filteredTotal,0);
}));
test('pagination crosses file boundaries without duplicates or omissions and excludes permanently removed files',()=>fixture(async library=>{
  const one=await upload(library,'A','a.log',Array.from({length:6},(_,i)=>'MATCH '+i).join('\n'));
  await upload(library,'A','b.log',Array.from({length:7},(_,i)=>'MATCH B'+i).join('\n'));
  const keys=[];let offset=0;
  do { const page=await library.search({query:'MATCH',offset,limit:4},{sessionId:'A'});assert.equal(page.filteredTotal,13);keys.push(...page.entries.map(row=>row.fileId+':'+row.sourceLine));offset=page.nextOffset; } while(offset!==null);
  assert.equal(keys.length,13);assert.equal(new Set(keys).size,13);
  await library.remove({ids:[one.id]},{sessionId:'A'});assert.equal((await library.search({query:'MATCH'},{sessionId:'A'})).filteredTotal,7);
}));
test('validates regex syntax and required scope, permits grouping and whitespace, and honors cancellation',()=>fixture(async library=>{
  await upload(library,'A','a.log','ERROR 42\nWARN 7\n');
  await assert.rejects(library.search({query:'(',regex:true},{sessionId:'A'}),/正则/);
  assert.equal((await library.search({query:'(ERROR|WARN) ([0-9]+)',mode:'regex'},{sessionId:'A'})).filteredTotal,2);
  assert.equal((await library.search({query:'ERROR [0-9]+$',regex:true},{sessionId:'A'})).filteredTotal,1);
  await assert.rejects(library.search({query:'x'},{}),/会话/);await assert.rejects(library.search({query:''},{sessionId:'A'}),/关键词/);
  assert.equal((await library.search({query:' '},{sessionId:'A'})).filteredTotal,2);
  const controller=new AbortController();controller.abort(Error('cancelled'));
  await assert.rejects(library.search({query:'ERROR'},{sessionId:'A'},controller.signal),/cancelled/);
}));

test('per-occurrence and one-per-line counts paginate repeated hits without omissions',()=>fixture(async library=>{
  const first=await upload(library,'A','a.log','hit hit\nno\nhit hit hit\n');
  const second=await upload(library,'A','b.log','hit\n');
  const rows=[];let offset=0;
  do{const page=await library.search({query:'hit',oneEntryPerLine:false,offset,limit:2},{sessionId:'A'});assert.equal(page.filteredTotal,3);assert.equal(page.totalHits,6);assert.equal(page.resultTotal,6);rows.push(...page.entries);offset=page.nextOffset;}while(offset!==null);
  assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>`${r.fileId}:${r.sourceLine}:${r.occurrenceIndex}`)).size,6);
  assert.deepEqual(rows.filter(r=>r.fileId===first.id&&r.sourceLine===1).map(r=>r.column),[1,5]);
  assert.deepEqual(rows.filter(r=>r.fileId===first.id&&r.sourceLine===3).map(r=>r.ranges),[[[0,3]],[[4,7]],[[8,11]]]);
  assert.equal(rows.at(-1).fileId,second.id);
  const linePage=await library.search({query:'hit',oneEntryPerLine:true,limit:2},{sessionId:'A'});assert.equal(linePage.resultTotal,3);assert.equal(linePage.nextOffset,2);assert.equal(linePage.entries[0].hitCount,2);assert.equal(linePage.entries[0].ranges.length,2);
  const tail=await library.search({query:'hit',oneEntryPerLine:true,offset:linePage.nextOffset,limit:2},{sessionId:'A'});assert.equal(tail.entries.length,1);assert.equal(tail.nextOffset,null);
}));

test('filename wildcard inclusion, exclusions and whitespace delimiters limit current-session search',()=>fixture(async library=>{
  for(const name of ['app1.log','app2.LOG','other.txt','ignored.log','noextension'])await upload(library,'A',name,'needle\n');
  await upload(library,'B','foreign.log','needle\n');
  for(const filePattern of ['app?.log;*.txt;!app2.log','app?.log *.txt !app2.log']){
    const result=await library.search({query:'needle',filePattern},{sessionId:'A'});assert.deepEqual(result.entries.map(r=>r.fileName).sort(),['app1.log','other.txt']);assert.equal(result.searchedFiles,2);
  }
  const all=await library.search({query:'needle',filePattern:'*.* !ignored.log'},{sessionId:'A'});assert.equal(all.searchedFiles,4);assert.ok(all.entries.some(r=>r.fileName==='noextension'));assert.ok(all.entries.every(r=>r.fileName!=='foreign.log'));
}));

test('whole-word boundaries and case match ignore substrings but support Unicode words',()=>fixture(async library=>{
  await upload(library,'A','word.log','cat catcat Cat _cat cat_\n猫 猫咪\n');
  const sensitive=await library.search({query:'cat',wholeWord:true,caseSensitive:true,oneEntryPerLine:false},{sessionId:'A'});assert.equal(sensitive.totalHits,1);
  const folded=await library.search({query:'cat',wholeWord:true,oneEntryPerLine:false},{sessionId:'A'});assert.equal(folded.totalHits,2);
  const unicode=await library.search({query:'猫',wholeWord:true,oneEntryPerLine:false},{sessionId:'A'});assert.equal(unicode.totalHits,1);
}));

test('extended LF/CRLF and multiline regex retain original starting lines and highlight columns',()=>fixture(async library=>{
  await upload(library,'A','lf.log','first\nsecond\nfirst\nsecond\n');
  await upload(library,'A','crlf.log','first\r\nsecond\r\n');
  const lf=await library.search({query:'first\\nsecond',mode:'extended',oneEntryPerLine:false},{sessionId:'A'});assert.equal(lf.totalHits,2);assert.deepEqual(lf.entries.map(r=>r.sourceLine),[1,3]);assert.ok(lf.entries.every(r=>r.column===1));
  const crlf=await library.search({query:'first\\r\\nsecond',mode:'extended'},{sessionId:'A'});assert.equal(crlf.totalHits,1);assert.equal(crlf.entries[0].fileName,'crlf.log');
  const regex=await library.search({query:'first\\r?\\nsecond',mode:'regex',oneEntryPerLine:false,limit:2},{sessionId:'A'});assert.equal(regex.totalHits,3);assert.equal(regex.resultTotal,3);assert.equal(regex.nextOffset,2);
  const dot=await library.search({query:'first.*?second',mode:'regex',dotMatchesNewline:true,oneEntryPerLine:false},{sessionId:'A'});assert.equal(dot.totalHits,3);
}));

test('query and filename boundaries are explicit and long-line truncation is not reported complete',()=>fixture(async library=>{
  await upload(library,'A','long.log','x'.repeat(8192)+'needle\nneedle\n');
  const found=await library.search({query:'needle'},{sessionId:'A'});assert.equal(found.filteredTotal,1);assert.equal(found.complete,false);assert.ok(found.errorCount>0);assert.match(found.errors[0].error,/8192/);
  await assert.rejects(library.search({query:'x'.repeat(2049)},{sessionId:'A'}),/2048/);
  await assert.rejects(library.search({query:'x',filePattern:'x'.repeat(1025)},{sessionId:'A'}),/1024/);
  await assert.rejects(library.search({query:'x',filePattern:Array(65).fill('*.log').join(';')},{sessionId:'A'}),/64/);
  await assert.rejects(library.search({query:'x',mode:'unsupported'},{sessionId:'A'}),/模式/);
  await upload(library,'A','boundary.log','x'.repeat(2048));
  const boundary=await library.search({query:'x'.repeat(2048),filePattern:'*'.repeat(1024)},{sessionId:'A'});assert.equal(boundary.filteredTotal,1);assert.equal(boundary.complete,false);
}));

test('CRLF newline and line-end matches keep visible ranges ordered and preserve source columns',()=>fixture(async library=>{
  await upload(library,'A','crlf.log','a\r\nb');
  for(const options of [{query:'\\n',mode:'extended'},{query:'$',mode:'regex'}]){
    for(const oneEntryPerLine of [false,true]){
      const page=await library.search({...options,oneEntryPerLine},{sessionId:'A'});
      assert.equal(page.complete,true);assert.ok(page.totalHits>=1);
      for(const row of page.entries)for(const [start,end]of row.ranges){assert.ok(start>=0&&end>=start&&end<=row.message.length);}
      assert.equal(page.entries.find(row=>row.sourceLine===1)?.ranges[0][0],1);
      if(!oneEntryPerLine||options.mode==='extended')assert.ok(page.entries.some(row=>row.sourceLine===1&&row.column===3));
    }
  }
}));

test('truncated long lines do not create whole-word matches at a synthetic boundary',()=>fixture(async library=>{
  await upload(library,'A','long.log','a'.repeat(8189)+'catZ\n');
  const page=await library.search({query:'cat',wholeWord:true},{sessionId:'A'});
  assert.equal(page.complete,false);assert.equal(page.totalHits,0);assert.match(page.errors[0].error,/未参与搜索/);
}));
