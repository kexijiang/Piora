import { dirname, join } from "node:path";
import { defaultHarmonyConfigPath } from "./runtime";
import { HarmonyDatabaseExportJobs } from "./database-export-jobs";

declare global { var __pioraHarmonyDatabaseExportJobs: HarmonyDatabaseExportJobs | undefined; }

export function getHarmonyDatabaseExportJobs(): HarmonyDatabaseExportJobs {
  return globalThis.__pioraHarmonyDatabaseExportJobs ??= new HarmonyDatabaseExportJobs(
    join(dirname(defaultHarmonyConfigPath()), "harmony-database-export-jobs.json"),
  );
}
