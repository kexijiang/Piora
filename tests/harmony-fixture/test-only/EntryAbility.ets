import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { TestBridge } from '../bridge/TestBridge';
import { exportAtlasDatabase } from '../atlas/AtlasFixture';
export default class EntryAbility extends UIAbility {
  onCreate(): void {
    AppStorage.setOrCreate('atlasExportPath', 'preparing-sample');
    exportAtlasDatabase(this.context)
      .then(path => { AppStorage.setOrCreate('atlasExportPath', path); })
      .catch((error: BusinessError) => {
        AppStorage.setOrCreate('atlasExportPath', `export-failed: ${error.code ?? 'unknown'} ${error.message ?? 'RDB export failed'}`);
      });
  }
  onWindowStageCreate(stage: window.WindowStage): void {
    stage.getMainWindow().then(main => main.setWindowKeepScreenOn(true))
      .catch(() => { console.error('Fixture keep-screen-on request failed'); });
    stage.loadContent('pages/TestIndex').catch(() => { console.error('Fixture UI failed to load'); });
  }
  onNewWant(want: Want): void {
    const packet = want.parameters?.pioraPcmPacket;
    if (typeof packet === 'string') TestBridge.receive(packet).catch(() => { AppStorage.setOrCreate('appTestResult', 'rejected'); });
  }
}
