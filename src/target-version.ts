import { execFile } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fingerprint, type Target } from './contracts.js';

const exec = promisify(execFile);
// ponytail: one cached repository snapshot; independent active repositories may recompute, never reuse stale data.
let cached: { key: string; changes: string } | undefined;

/** The same entry point is checked before preparation and fingerprinted before execution. */
export function targetEntryPath(target: Target): string | undefined {
  const entry = target.kind === 'module' ? target.path : target.kind === 'command'
    ? target.args.find(arg => /\.(?:[cm]?js|ts|py|sh)$/.test(arg)) : undefined;
  return entry ? resolve(target.kind === 'command' ? target.cwd ?? process.cwd() : '.', entry) : undefined;
}

/** Record local code identity without persisting source code, diffs or environment secrets. */
export async function targetFingerprint(target: Target): Promise<string | undefined> {
  const path = targetEntryPath(target);
  if (!path) return undefined;
  try {
    const entryStat = await stat(path);
    if (!entryStat.isFile()) throw Object.assign(new Error(), { code: 'EISDIR' });
    if (entryStat.size > 5_000_000) throw Object.assign(new Error(), { code: 'EFBIG' });
    const content = await readFile(path, 'utf8');
    let commit: string | undefined;
    try { commit = (await exec('git', ['-C', dirname(path), 'rev-parse', 'HEAD'], { timeout: 5000 })).stdout.trim(); }
    catch { /* A standalone adapter can still be identified by its content. */ }
    let changes: string | undefined;
    if (commit) {
      const git = async (args: string[]) => (await exec('git', ['-C', dirname(path), ...args], { timeout: 5000, maxBuffer: 20_000_000 })).stdout;
      const root = (await git(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
      const names = (await git(['diff', '--no-relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean);
      const metadata = await Promise.all(names.map(async name => {
        try { const s = await lstat(resolve(root, name), { bigint: true }); return [name, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].map(String); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, 'deleted']; throw error; }
      }));
      const key = fingerprint({ path, commit, metadata });
      if (cached?.key !== key) cached = { key, changes: await git(['diff', '--no-relative', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']) };
      changes = cached.changes;
    }
    // Fingerprints cover the entry point and tracked Git changes; remote services, untracked dependencies and environment changes need targetVersion.
    return fingerprint({ content, commit, changes });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' || code === 'ENOTDIR' ? `Не найден файл агента: ${path}. Исправьте путь в подключении.`
      : code === 'EISDIR' ? `Вместо файла агента указана папка: ${path}. Выберите файл адаптера.`
      : code === 'EFBIG' ? 'Точка входа агента превышает 5 МБ. Укажите небольшой адаптер.'
      : code === 'EACCES' || code === 'EPERM' ? `Нет доступа к файлу агента: ${path}. Проверьте права чтения.`
      : `Не удалось проверить версию агента: ${path}. Проверьте доступ к файлам и состояние Git; черновик можно повторить после исправления.`);
  }
}
