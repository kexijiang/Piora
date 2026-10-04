import { TestBridge } from '../bridge/TestBridge';
import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { exportAtlasDatabase, prepareEncryptedAtlasDatabase } from '../atlas/AtlasFixture';
import { BusinessError } from '@kit.BasicServicesKit';
@Entry
@Component
struct TestIndex {
  @State runId: string = '';
  @State orientationStatus: string = 'not-requested';
  @State actionCount: number = 0;
  @State encryptedStatus: string = 'encrypted-not-prepared';
  @State encryptedPreparing: boolean = false;
  @StorageLink('appTestPairing') pairing: string = 'not-paired';
  @StorageLink('appTestResult') result: string = 'not-run';
  @StorageLink('atlasExportPath') atlasExport: string = 'preparing-sample';
  async setTestOrientation(orientation: window.Orientation): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const main = await window.getLastWindow(context);
      await main.setPreferredOrientation(orientation);
      this.orientationStatus = orientation === window.Orientation.LANDSCAPE ? 'landscape-requested' : 'portrait-requested';
    } catch (error) {
      this.orientationStatus = 'orientation-request-failed';
    }
  }
  async exportDatabase(): Promise<void> {
    this.atlasExport = 'exporting';
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.atlasExport = await exportAtlasDatabase(context);
    } catch (error) {
      this.atlasExport = 'export-failed';
    }
  }
  async prepareEncryptedSample(): Promise<void> {
    if (this.encryptedPreparing) return;
    this.encryptedPreparing = true;
    this.encryptedStatus = 'encrypted-preparing';
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      await prepareEncryptedAtlasDatabase(context);
      this.encryptedStatus = 'encrypted-ready';
    } catch (error) {
      this.encryptedStatus = `encrypted-failed: ${(error as BusinessError).code ?? 'unknown'}`;
    } finally {
      this.encryptedPreparing = false;
    }
  }
  build() {
    Scroll() {
    Column({ space: 16 }) {
      Row({ space: 8 }) {
        Button('Test landscape').id('atlas-landscape').onClick(() => { this.setTestOrientation(window.Orientation.LANDSCAPE); })
        Button('Restore portrait').id('atlas-portrait').onClick(() => { this.setTestOrientation(window.Orientation.PORTRAIT); })
      }
      Text(this.orientationStatus).id('atlas-orientation-status')
      Row({ space: 8 }) {
        Button('Increment test counter').id('atlas-action-increment').onClick(() => { this.actionCount++; })
        Text(`Actions: ${this.actionCount}`).id('atlas-action-count')
      }
      Button('Prepare encrypted sample').id('atlas-encrypted-prepare')
        .enabled(!this.encryptedPreparing).onClick(() => { this.prepareEncryptedSample(); })
      Text(this.encryptedStatus).id('atlas-encrypted-status')
      Text(this.atlasExport).id('atlas-export-path').copyOption(CopyOptions.LocalDevice)
      Text('DEBUG PCM bridge — does not cover the microphone or speech recognition')
      TextInput({ text: this.runId, placeholder: 'Task/run identifier' }).onChange(value => { this.runId = value; })
      Button('Pair once for 2 minutes').onClick(() => {
        try { this.pairing = TestBridge.pair(this.runId); this.result = 'ready'; }
        catch (error) { this.result = 'invalid-run'; }
      })
      Text(this.pairing).id('app-test-pairing').copyOption(CopyOptions.LocalDevice)
      Text(this.result).id('app-test-result')
      Button('Export SQLite acceptance sample').id('atlas-export').onClick(() => { this.exportDatabase(); })
    }.padding(24)
    }.width('100%').height('100%').id('atlas-test-scroll')
  }
}
