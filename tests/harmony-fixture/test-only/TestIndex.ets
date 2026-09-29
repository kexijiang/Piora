import { TestBridge } from '../bridge/TestBridge';
import { common } from '@kit.AbilityKit';
import { exportAtlasDatabase } from '../atlas/AtlasFixture';
@Entry
@Component
struct TestIndex {
  @State runId: string = '';
  @StorageLink('appTestPairing') pairing: string = 'not-paired';
  @StorageLink('appTestResult') result: string = 'not-run';
  @State atlasExport: string = 'not-exported';
  async exportDatabase(): Promise<void> {
    this.atlasExport = 'exporting';
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.atlasExport = await exportAtlasDatabase(context);
    } catch (error) {
      this.atlasExport = 'export-failed';
    }
  }
  build() {
    Column({ space: 16 }) {
      Text('DEBUG PCM bridge — does not cover the microphone or speech recognition')
      TextInput({ text: this.runId, placeholder: 'Task/run identifier' }).onChange(value => { this.runId = value; })
      Button('Pair once for 2 minutes').onClick(() => {
        try { this.pairing = TestBridge.pair(this.runId); this.result = 'ready'; }
        catch (error) { this.result = 'invalid-run'; }
      })
      Text(this.pairing).id('app-test-pairing').copyOption(CopyOptions.LocalDevice)
      Text(this.result).id('app-test-result')
      Button('Export SQLite acceptance sample').id('atlas-export').onClick(() => { this.exportDatabase(); })
      Text(this.atlasExport).id('atlas-export-path').copyOption(CopyOptions.LocalDevice)
    }.padding(24)
  }
}
