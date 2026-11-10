// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
import { parentPort, workerData } from 'node:worker_threads';
import { indexLog, blockPage, materializeLog, sessionSearchPage } from './log-storage.mjs';
const operations = { index: indexLog, page: blockPage, materialize: materializeLog, search: sessionSearchPage };
try { const fn = operations[workerData.operation]; if (!fn) throw Error('无效日志后台任务'); const value = await fn(workerData.payload, progress => parentPort.postMessage({ progress })); parentPort.postMessage({ value }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
