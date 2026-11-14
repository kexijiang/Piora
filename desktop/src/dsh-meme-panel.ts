/** Add controls missing from upstream's standalone page; all mutations use upstream APIs. */
export function extendMemePanel(source: string): string {
  if (source.split("</body>").length !== 2) throw new Error("Unsupported DSH Meme panel layout");
  return source.replace("</body>", String.raw`<style>
@supports (appearance: base-select) {
  select:not([multiple]), select:not([multiple])::picker(select) { appearance: base-select; }
  select:not([multiple]) { align-items: center; gap: 8px; min-width: 0; border-radius: 8px; font: inherit; }
  select:not([multiple])::picker(select) { min-width: anchor-size(width); max-width: calc(100vw - 16px); max-height: min(360px, 55dvh); margin-block: 5px; padding: 5px; overflow: auto; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; background: var(--bg, Canvas); color: var(--text, CanvasText); box-shadow: 0 10px 28px #0003; font: inherit; }
  select:not([multiple]) option { display: flex; align-items: center; gap: 16px; min-height: 34px; padding: 8px 10px; border-radius: 7px; white-space: normal; overflow-wrap: anywhere; }
  select:not([multiple]) option:checked { background: color-mix(in srgb, currentColor 10%, transparent); }
  select:not([multiple]) option:not(:disabled):is(:hover, :focus-visible) { background: color-mix(in srgb, currentColor 7%, transparent); }
  select:not([multiple]) option:disabled { opacity: .5; }
  select:not([multiple]) option::checkmark { order: 1; margin-left: auto; content: "✓"; }
}
</style><script>
(async () => {
  const bar = document.createElement('section'); bar.className = 'row';
  bar.innerHTML = '<label>发图频率 <select id="piora-gear"><option value="off">关闭主动发图</option><option value="auto">看气氛</option><option value="active">活跃</option><option value="always">每轮都发</option></select></label><label>发送方式 <select id="piora-mode"><option value="auto">自动</option><option value="text">纯文字</option><option value="image">图片</option></select></label><label>图库 <select id="piora-pack"></select></label><label><input id="piora-enabled" type="checkbox">模型可用</label><button id="piora-zip">导入 ZIP</button><input id="piora-zip-file" type="file" accept=".zip" hidden><button id="piora-export">导出当前图库</button><button id="piora-recognize">AI 识别并收藏图片</button><input id="piora-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>';
  document.querySelector('h1').after(bar);
  let state;
  const el = id => document.getElementById(id);
  const refresh = async () => {
    state = await apiPost({op:'getMemeRoot'}); if (!state.ok) throw Error(state.error);
    el('piora-gear').value = state.sendGear; el('piora-mode').value = state.sendMode;
    el('piora-pack').replaceChildren(...state.packs.map(p => { const o=document.createElement('option');o.value=p.id;o.textContent=p.name;return o; }));
    el('piora-pack').value=state.packId; el('piora-enabled').checked=state.enabledPacks.includes(state.packId);
  };
  const change = async payload => { const r=await apiPost(payload);if(!r.ok)throw Error(r.error || r.message);await refresh();await load(); };
  const run = fn => async () => { try { await fn(); notice('已完成','ok'); } catch(e) { notice(e.message,'err'); } };
  el('piora-gear').onchange=run(()=>change({op:'setSendGear',gear:el('piora-gear').value}));
  el('piora-mode').onchange=run(()=>change({op:'setSendMode',sendMode:el('piora-mode').value}));
  el('piora-pack').onchange=run(()=>change({op:'setPack',packId:el('piora-pack').value}));
  el('piora-enabled').onchange=run(()=>change({op:'setPackEnabled',packId:state.packId,enabled:el('piora-enabled').checked}));
  const base64 = file => new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(Error('读取失败'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(file)});
  el('piora-zip').onclick=()=>el('piora-zip-file').click();
  el('piora-zip-file').onchange=run(async()=>{const file=el('piora-zip-file').files[0];if(!file)return;if(file.size>20*1024*1024)throw Error('ZIP 最大 20 MB');await change({op:'importMemePack',fileName:file.name,dataBase64:await base64(file)});el('piora-zip-file').value='';});
  el('piora-export').onclick=run(async()=>{const r=await fetch('/dsh-memes-export?packId='+encodeURIComponent(state.packId));if(!r.ok)throw Error('导出失败');const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=state.packId+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);});
  el('piora-recognize').onclick=()=>el('piora-image').click();
  el('piora-image').onchange=run(async()=>{const file=el('piora-image').files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('图片最大 8 MB');const dataBase64=await base64(file);const result=await apiPost({op:'recognize',fileName:file.name,dataBase64});if(!result.ok)throw Error(result.error);await change({op:'upload',fileName:file.name,dataBase64,tag:result.tag,caption:result.caption,keywords:result.keywords});el('piora-image').value='';});
  try { await refresh(); } catch(e) { notice(e.message,'err'); }
})();
</script></body>`);
}
