/**
 * Reference module adapter for Agent Lab external targets.
 *
 * Contract: `export function createSession({ sessionId, scenarioId, initialState })` returns an object with
 * `respond(message, messages)` and optional `close()`. `respond` returns either a plain string or
 * `{ reply, events?: [{ tool, args?, result? }], records?: { recordId: { field: scalar } } }`.
 * Returned `records` replace the trial's world before objective checks run; returned `events`
 * appear in the trace. Agent Lab never executes anything else from this module.
 */
export function createSession({ initialState, sessionId }) {
  const records = structuredClone(initialState.records);
  let turn = 0;
  return {
    async respond(message) {
      const observation = { eventsComplete: true, resetConfirmed: true, sessionId, turn: ++turn, version: 'echo-module-1',
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      const id = Object.keys(records)[0];
      const time = message.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0];
      if (id && time && 'time' in records[id]) {
        const before = structuredClone(records[id]);
        records[id].time = time;
        return {
          ...observation,
          reply: `Moved ${id} to ${time}.`,
          events: [
            { tool: 'lookup_record', args: { recordId: id }, result: { ok: true, recordId: id, record: before } },
            { tool: 'update_record', args: { recordId: id, changes: { time } }, result: { ok: true, recordId: id, record: records[id] } },
          ],
          records,
        };
      }
      return { ...observation, reply: `You said: ${message}`, events: [], records };
    },
    async close() {},
  };
}
