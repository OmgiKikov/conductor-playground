import { z } from 'zod';
import { scalarSchema, type CallContext, type Source, type Tool, type Trial, type World } from './contracts.js';

/*
 * Trusted record sandbox. Tools mutate one per-trial World and record every attempt:
 *
 *   target session ──call──► tool(name,args) ──push tool_call(state)──► execute ──push tool_result(state)──► result
 *
 * Failed calls never change records; transientFailures counts down on update_record only.
 */
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const queryArgs = z.strictObject({ query: z.string().trim().min(1).max(1000) });
const lookupArgs = z.strictObject({ recordId: identifier });
const updateArgs = z.strictObject({ recordId: identifier, changes: z.record(identifier, scalarSchema) })
  .refine(v => Object.keys(v.changes).length > 0 && Object.keys(v.changes).length <= 16, 'Supply 1–16 changed fields');
const objectParameters = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const stringParameter = { type: 'string', minLength: 1, maxLength: 1000 };

export function sandbox(state: World, sources: Source[], push: (event: Omit<Trial['events'][number], 'seq'>) => void, ctx: CallContext): Tool[] {
  function tool(name: Tool['name'], description: string, parameters: Tool['parameters'], execute: (args: unknown) => unknown): Tool {
    return { name, description, parameters, async execute(args) {
      ctx.signal.throwIfAborted();
      push({ type: 'tool_call', tool: name, args, state });
      let result: unknown;
      try { result = execute(args); }
      catch (error) { result = { ok: false, error: error instanceof z.ZodError ? 'Invalid tool arguments' : error instanceof Error ? error.message : 'Tool failed', retryable: false }; }
      push({ type: 'tool_result', tool: name, result, state });
      return structuredClone(result);
    } };
  }
  return [
    tool('search_materials', 'Search the supplied business policy materials. Returns source IDs and matching text.',
      objectParameters({ query: stringParameter }, ['query']), raw => {
        const { query } = queryArgs.parse(raw);
        const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const matches = sources.map(source => {
          const lower = source.content.toLocaleLowerCase();
          const index = Math.min(...words.map(w => lower.indexOf(w)).filter(i => i >= 0));
          return { sourceId: source.id, name: source.name, content: Number.isFinite(index) ? source.content.slice(Math.max(0, index - 200), index + 1800) : '', matched: Number.isFinite(index) };
        }).filter(m => m.matched).slice(0, 8).map(({ matched: _matched, ...match }) => match);
        return { ok: true, matches };
      }),
    tool('lookup_record', 'Read an existing sandbox record by its exact ID. Never invent a missing record.',
      objectParameters({ recordId: stringParameter }, ['recordId']), raw => {
        const { recordId } = lookupArgs.parse(raw);
        if (!Object.hasOwn(state.records, recordId)) return { ok: false, error: 'Record not found', retryable: false };
        return { ok: true, recordId, record: state.records[recordId] };
      }),
    tool('update_record', 'Update existing, explicitly writable fields in an existing record. Retry retryable errors; a failed result made no record changes.',
      objectParameters({ recordId: stringParameter, changes: { type: 'object', minProperties: 1, maxProperties: 16, additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } } }, ['recordId', 'changes']), raw => {
        const { recordId, changes } = updateArgs.parse(raw);
        const record = Object.hasOwn(state.records, recordId) ? state.records[recordId] : undefined;
        if (!record) return { ok: false, error: 'Record not found', retryable: false };
        if (Object.keys(changes).some(field => !state.writableFields.includes(field) || !Object.hasOwn(record, field))) {
          return { ok: false, error: 'A field does not exist or is not writable; no changes applied', retryable: false };
        }
        if (state.transientFailures > 0) {
          state.transientFailures -= 1;
          return { ok: false, error: 'Temporary update failure; retry is safe', retryable: true };
        }
        Object.assign(record, changes);
        return { ok: true, recordId, record };
      }),
  ];
}
