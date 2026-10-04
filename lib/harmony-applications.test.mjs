import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const {parseApplicationLabels,parseBundleList,parseApplicationAbilities,parseApplicationDetails}=await createJiti(import.meta.url).import('./harmony/observation/applications.ts');
test('application discovery uses upstream bm label JSON and verified exported abilities',()=> {
  assert.deepEqual(parseApplicationLabels('[{"bundleName":"com.test.app","label":"中文测试"}]'),[{bundleName:'com.test.app',label:'中文测试',source:'bm-label'}]);
  assert.deepEqual(parseBundleList('bundle list:\ncom.test.app\n'),[{bundleName:'com.test.app',source:'bm-bundle'}]);
  assert.deepEqual(parseApplicationAbilities('com.test.app:\n'+JSON.stringify({name:'com.test.app',hapModuleInfos:[{abilityInfos:[{name:'EntryAbility',exported:true},{name:'Private',exported:false},{name:'Disabled',exported:true,enabled:false}]}]}),'com.test.app'),['EntryAbility']);
  assert.throws(()=>parseApplicationLabels('permission denied'));
  assert.throws(()=>parseApplicationAbilities('{"name":"com.other.app"}','com.test.app'));
});

test('selected application details include bounded version and permission facts only for the requested bundle',()=> {
  const output=JSON.stringify({name:'com.test.app',versionName:'1.2.3',versionCode:42,installTime:123456,
    reqPermissions:['ohos.permission.CAMERA',{name:'ohos.permission.READ_MEDIA'},'bad;command'],
    abilityInfos:[{name:'EntryAbility',exported:true}]});
  assert.deepEqual(parseApplicationDetails(output,'com.test.app'),{
    bundleName:'com.test.app',source:'bm-bundle',abilities:['EntryAbility'],versionName:'1.2.3',versionCode:42,
    installTime:123456,updateTime:undefined,requestedPermissions:['ohos.permission.CAMERA','ohos.permission.READ_MEDIA']});
  assert.throws(()=>parseApplicationDetails(output,'com.other.app'));
});

test('real bm visible abilities are discovered without admitting hidden, disabled or conflicting entries',()=> {
  const bundleName='dev.piora.audio.fixture';
  const dump=JSON.stringify({name:bundleName,hapModuleInfos:[{abilityInfos:[
    {name:'EntryAbility',visible:true,enabled:true},
    {name:'BothConfirmed',visible:true,exported:true},
    {name:'Hidden',visible:false},
    {name:'Disabled',visible:true,enabled:false},
    {name:'Conflict',visible:true,exported:false},
    {name:'ReverseConflict',visible:false,exported:true},
    {name:'Unknown'},
    {name:'StringFlag',visible:'true'},
    {name:'MalformedMixed',visible:true,exported:'true'},
    {name:'bad;command',visible:true},
    {name:'EntryAbility',visible:true}
  ]}]});
  assert.deepEqual(parseApplicationAbilities(dump,bundleName),['BothConfirmed','EntryAbility']);
  assert.deepEqual(parseApplicationDetails(dump,bundleName).abilities,['BothConfirmed','EntryAbility']);
});

test('application classification uses explicit matching bundle facts without guessing prefixes or coercing values',()=> {
  const bundleName='com.vendor.systemlookingapp';
  const data={name:bundleName,applicationInfo:{bundleName,isSystemApp:false,removable:true,userDataClearable:false,
    enabled:false,debug:true,appProvisionType:'debug',installSource:'com.example.store',process:bundleName+':worker',
    codePath:'/private/path',fingerprint:'private-certificate',permissions:[]}};
  const app=parseApplicationDetails(JSON.stringify(data),bundleName);
  assert.equal(app.isSystemApp,false); assert.equal(app.dataClearable,false); assert.equal(app.removable,true);
  assert.equal(app.enabled,false); assert.equal(app.debug,true); assert.equal(app.provisionType,'debug');
  assert.equal(app.installSource,'com.example.store'); assert.equal(app.process,bundleName+':worker');
  assert.equal('codePath' in app,false); assert.equal('fingerprint' in app,false);
  const unknown=parseApplicationDetails(JSON.stringify({name:bundleName,applicationInfo:{bundleName,isSystemApp:'true',removable:1,
    debug:'false',installSource:'bad\nsource',appProvisionType:'maybe'}}),bundleName);
  assert.equal(unknown.isSystemApp,undefined); assert.equal(unknown.removable,undefined); assert.equal(unknown.provisionType,undefined);
  assert.equal(unknown.installSource,undefined);
  const foreign=parseApplicationDetails(JSON.stringify({name:bundleName,applicationInfo:{bundleName:'com.other.app',isSystemApp:true}}),bundleName);
  assert.equal(foreign.isSystemApp,undefined);
  const conflict=parseApplicationDetails(JSON.stringify({name:bundleName,applicationInfo:{bundleName,isSystemApp:true,systemApp:false,userDataClearable:true,dataUnclearable:true}}),bundleName);
  assert.equal(conflict.isSystemApp,undefined); assert.equal(conflict.dataClearable,undefined);
  assert.equal(parseApplicationLabels(JSON.stringify([{bundleName,systemApp:true}]))[0].isSystemApp,true);
  assert.equal(parseApplicationDetails(JSON.stringify({name:bundleName,applicationInfo:{bundleName,systemApp:true,dataUnclearable:true}}),bundleName).dataClearable,false);
});
