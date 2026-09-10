import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { experimentSchema, type Experiment, type TraceEvent } from './contracts.js';

const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
export class ExperimentStore {
  readonly directory: string;
  private lockToken: string | null = null;
  constructor(directory: string) { this.directory = resolve(directory); }
  private path(id: string): string {
    if (!idPattern.test(id)) throw new Error('Invalid experiment ID');
    return join(this.directory, `${id}.json`);
  }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, '.lock');
      try {
        const lock = await open(lockPath, 'wx', 0o600);
        this.lockToken = randomUUID();
        try { await lock.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); }
        finally { await lock.close(); }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
        if (!owner || typeof owner !== 'object' || !('pid' in owner) || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid data-directory lock. Inspect .lock before removing it.');
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') throw new Error(`A previous Agent Lab process stopped. Verify no other instance uses this directory, then remove ${lockPath} and restart. Partial experiments will be marked interrupted.`);
          throw probe;
        }
        throw new Error('This data directory is already open in another Agent Lab instance.');
      }
  }
  async close(): Promise<void> {
    if (!this.lockToken) return;
    const token = this.lockToken;
    this.lockToken = null;
    const lockPath = join(this.directory, '.lock');
    const owner: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (owner && typeof owner === 'object' && 'token' in owner && owner.token === token) await unlink(lockPath);
  }
  async save(record: Experiment): Promise<void> {
    const validated = experimentSchema.parse(record);
    const target = this.path(validated.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(validated, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async get(id: string): Promise<Experiment> {
    const file = await open(this.path(id), 'r');
    try {
      if ((await file.stat()).size > 50_000_000) throw new Error('Experiment record exceeds 50 MB');
      const record = experimentSchema.parse(JSON.parse(await file.readFile('utf8')));
      if (record.id !== id) throw new Error('Experiment ID does not match its file');
      return record;
    } finally { await file.close(); }
  }
  async list(): Promise<Experiment[]> {
    const names = await readdir(this.directory);
    const records = await Promise.all(names.filter(n => n.endsWith('.json') && idPattern.test(n.slice(0, -5))).map(n => this.get(n.slice(0, -5))));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  appendTrace(id: string, trialId: string, event: TraceEvent): void {
    this.path(id);
    if (!idPattern.test(trialId)) throw new Error('Invalid trial ID');
    appendFileSync(join(this.directory, `${id}.trace.jsonl`), `${JSON.stringify({ trialId, event })}\n`, { mode: 0o600 });
  }
  async traceJournal(id: string): Promise<string> {
    this.path(id);
    try { return await readFile(join(this.directory, `${id}.trace.jsonl`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
}
