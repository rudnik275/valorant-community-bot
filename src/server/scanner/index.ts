/**
 * scanner/index.ts — Public API for the scanner module.
 */

export { scannerEvents } from './events.ts';
export { scanForPuuid, type ScanResult, type ScanOpts } from './scan.ts';
export { startScanLoop, type StartScanLoopOpts } from './loop.ts';
export { deriveMatchRecord, type MatchRecordInsert } from './derive.ts';
