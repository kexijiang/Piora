/* eslint-disable @typescript-eslint/no-require-imports -- Electron main-process fixture uses CommonJS before app readiness. */
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.PIORA_BROWSER_TEST_HOME);
app.commandLine.appendSwitch('disable-gpu');
const { DesktopBrowserManager } = require('../desktop/dist/browser-manager.js');
const origin = process.env.PIORA_BROWSER_TEST_URL;
const phase = process.env.PIORA_BROWSER_TEST_PHASE;
app.whenReady().then(async () => {
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const manager = new DesktopBrowserManager(window,{info(){},warn(message){console.error(message);}},()=>false);
  try {
    await manager.performAction({action:'set_session',sessionId:'fixture'});
    await manager.performAction({action:'navigate',url:origin+(phase==='save'?'/login':'/check')});
    const view=manager.tabs.find(t=>t.sessionId==='fixture').view;
    window.contentView.addChildView(view);view.setBounds({x:0,y:0,width:800,height:600});view.setVisible(true);
    const contents=view.webContents;contents.setBackgroundThrottling(false);
    if(phase==='save'){
      await contents.executeJavaScript(`localStorage.setItem('fixture','retained');window.authResult='';window.addEventListener('message',e=>{if(e.origin===location.origin)window.authResult=e.data;});const form=document.createElement('form');form.action='/popup';form.method='POST';form.target='login-popup';document.body.appendChild(form);setTimeout(()=>form.submit(),0);true;`,true);
      const until=Date.now()+10000;
      while(Date.now()<until && await contents.executeJavaScript('window.authResult')!=='login-complete') await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(await contents.executeJavaScript('window.authResult'),'login-complete','POST login popup must preserve window.opener');
      await manager.flushStorage();
      console.log('PASS native Electron login popup POST/opener callback and encrypted session save');
    }else{
      assert.equal(await contents.executeJavaScript('document.body.textContent'),'signed-in','login cookie must survive app restart');
      assert.equal(await contents.executeJavaScript("localStorage.getItem('fixture')"),'retained');
      console.log('PASS native Electron restart retains session cookie and localStorage');
    }
    await manager.flushStorage();manager.destroy();window.destroy();app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1);});
