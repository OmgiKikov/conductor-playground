import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { experimentSchema, type Experiment, type TraceEvent } from './contracts.js';

const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
type LockOwner = { pid: number; token: string };
const busy = () => new Error('This data directory is already open in another Agent Lab instance. Просмотр и экспорт остаются доступны.');
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}
export class ExperimentStore {
  readonly directory: string;
  diagnostics: { id: string; message: string }[] = [];
  private lockToken: string | null = null;
  constructor(directory: string) { this.directory = resolve(directory); }
  private path(id: string): string {
    if (!idPattern.test(id)) throw new Error('Invalid experiment ID');
    return join(this.directory, `${id}.json`);
  }
  private async owner(): Promise<LockOwner | null> {
    const lockPath = join(this.directory, '.lock');
    let raw: unknown;
    try { raw = JSON.parse(await readFile(lockPath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!raw || typeof raw !== 'object' || !('pid' in raw) || typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0
      || !('token' in raw) || typeof raw.token !== 'string' || !raw.token) {
      throw new Error(`Некорректный lock: ${lockPath}. Исходный файл сохранён; проверьте владельца перед восстановлением.`);
    }
    return { pid: raw.pid, token: raw.token };
  }
  private async acquire(): Promise<void> {
    const path = join(this.directory, '.lock');
    let lock;
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy(); throw error; }
    const token = randomUUID();
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, token })); this.lockToken = token; }
    catch (error) { await unlink(path); throw error; }
    finally { await lock.close(); }
  }
  /** Only writers initialize; atomic records and the journal can be read without owning the lock. */
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const observed = await this.owner();
    if (!observed) { await this.acquire(); return; }
    if (alive(observed.pid)) throw busy();
    // ponytail: one recovery gate per local directory; ambiguous gates need manual inspection, not recursive lock recovery.
    const recoveryPath = join(this.directory, '.recovery');
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Восстановление уже занято: ${recoveryPath}. Если предыдущий процесс завершился, проверьте этот файл; действующий lock не изменён.`);
      throw error;
    }
    try {
      await recovery.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
      const current = await this.owner();
      if (current) {
        if (current.pid !== observed.pid || current.token !== observed.token || alive(current.pid)) throw busy();
        await unlink(join(this.directory, '.lock'));
      }
      await this.acquire();
    } finally {
      try { await recovery.close(); } finally { await unlink(recoveryPath); }
    }
  }
  async close(): Promise<void> {
    if (!this.lockToken) return;
    const token = this.lockToken;
    this.lockToken = null;
    const lockPath = join(this.directory, '.lock');
    const owner = await this.owner();
    if (owner?.token === token) await unlink(lockPath);
  }
  async save(record: Experiment): Promise<void> {
    if (!this.lockToken) throw new Error('Для изменения записи откройте лабораторию как писатель.');
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
    this.diagnostics = [];
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const ids = names.filter(n => n.endsWith('.json') && idPattern.test(n.slice(0, -5))).map(n => n.slice(0, -5));
    const results = await Promise.allSettled(ids.map(id => this.get(id)));
    const records: Experiment[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') records.push(result.value);
      else this.diagnostics.push({ id: ids[index]!, message: result.reason instanceof SyntaxError ? 'Некорректный JSON. Исходный файл сохранён.'
        : String(result.reason instanceof Error ? result.reason.message : result.reason).replace(/\s+/g, ' ').slice(0, 240) });
    });
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  appendTrace(id: string, trialId: string, event: TraceEvent): void {
    if (!this.lockToken) throw new Error('Для записи трассы откройте лабораторию как писатель.');
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
