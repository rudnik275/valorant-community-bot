import { EventEmitter } from 'node:events';

/**
 * Scanner event emitter.
 *
 * Emits:
 *   'newRecord' — (record: MatchRecordInsert) — emitted for each newly inserted match record
 *                 when scanForPuuid is called with { detection: true }.
 */
export const scannerEvents = new EventEmitter();
