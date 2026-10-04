import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { fileIo } from '@kit.CoreFileKit';

/** Created only by the explicit debug sample button, never by discovery. */
export async function prepareEncryptedAtlasDatabase(context: common.UIAbilityContext): Promise<void> {
  const store = await relationalStore.getRdbStore(context, {
    name: 'piora-atlas-encrypted.db',
    securityLevel: relationalStore.SecurityLevel.S1,
    encrypt: true
  });
  try {
    await store.executeSql('CREATE TABLE IF NOT EXISTS encrypted_sample (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    await store.executeSql("INSERT OR REPLACE INTO encrypted_sample VALUES (1, 'synthetic encrypted acceptance sample')");
  } finally {
    await store.close();
  }
}

/** Synthetic data for the Harmony device panel's debug-only SQLite acceptance. */
export async function exportAtlasDatabase(context: common.UIAbilityContext): Promise<string> {
  const store = await relationalStore.getRdbStore(context, {
    name: 'piora-atlas-live.db',
    securityLevel: relationalStore.SecurityLevel.S1
  });
  await store.executeSql('CREATE TABLE IF NOT EXISTS atlas_sample (id INTEGER PRIMARY KEY, label TEXT NOT NULL, big_number INTEGER NOT NULL, payload BLOB NOT NULL)');
  await store.executeSql('CREATE INDEX IF NOT EXISTS atlas_label_index ON atlas_sample(label COLLATE NOCASE DESC)');
  await store.executeSql('CREATE VIEW IF NOT EXISTS atlas_labels AS SELECT id, label FROM atlas_sample');
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
