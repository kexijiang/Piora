import {readFile} from 'node:fs/promises';
import JSZip from 'jszip';
const path=process.argv[2]; if(!path)throw new Error('Pass a production fixture HAP built by the controlled CI runner');
const zip=await JSZip.loadAsync(await readFile(path));
let scanned=0;
for(const entry of Object.values(zip.files)) {
 if(entry.dir)continue;
 const bytes=await entry.async('nodebuffer'); scanned+=bytes.length;
 if(scanned>256*1024*1024)throw new Error('Expanded HAP exceeds scan limit');
 if(/TestBridge|BridgeSession|PcmTestInputSource|pioraPcmPacket|appTestPairing|AtlasFixture|atlas-action-increment|atlas-encrypted-prepare|atlas-landscape|atlas-portrait/.test(entry.name+'\n'+bytes.toString('utf8')))throw new Error(`Production HAP contains a debug acceptance entry: ${entry.name}`);
}
if(!scanned)throw new Error('Empty HAP');
console.log('Production HAP has no known debug acceptance paths or symbols');
