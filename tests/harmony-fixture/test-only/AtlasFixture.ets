import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { fileIo } from '@kit.CoreFileKit';

/** Synthetic data for the Harmony device panel's debug-only SQLite acceptance. */
export async function exportAtlasDatabase(context: common.UIAbilityContext): Promise<string> {
  const store = await relationalStore.getRdbStore(context, {
    name: 'piora-atlas-live.db',
    securityLevel: relationalStore.SecurityLevel.S1
  });
  await store.executeSql('CREATE TABLE IF NOT EXISTS atlas_sample (id INTEGER PRIMARY KEY, label TEXT NOT NULL, big_number INTEGER NOT NULL, payload BLOB NOT NULL)');
  await store.executeSql('DELETE FROM atlas_sample');
  await store.executeSql("INSERT INTO atlas_sample VALUES (1, '中文与空格', 9007199254740993, x'0001FEFF')");
  await store.executeSql("INSERT INTO atlas_sample VALUES (2, 'second row', -9007199254740993, x'10203040')");

  // RdbStore.backup() creates a consistent copy even if the live database uses WAL.
  const name = `piora-atlas-export-${Date.now()}.db`;
  await store.backup(name);
  const nested = `${context.databaseDir}/rdb/${name}`;
  const direct = `${context.databaseDir}/${name}`;
  const source = fileIo.accessSync(nested) ? nested : direct;
  if (!fileIo.accessSync(source)) throw new Error('RDB backup file was not found');
  const exported = `${context.filesDir}/${name}`;
  await fileIo.copyFile(source, exported);
  if (!fileIo.accessSync(exported)) throw new Error('RDB export file was not found');
  return exported;
}
