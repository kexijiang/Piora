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
