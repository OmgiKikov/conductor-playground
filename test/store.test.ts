import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { ExperimentStore } from '../src/store.js';
import { ExperimentLab } from '../src/experiment.js';
import { demoEvaluationInput } from '../src/demo.js';

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lab-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function lines(child: ChildProcessWithoutNullStreams) {
  const queued: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  createInterface({ input: child.stdout }).on('line', line => { if (waiting) { const done = waiting; waiting = undefined; done(line); } else queued.push(line); });
  return () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<string>(resolve => { waiting = resolve; });
}

test('readers see valid records and diagnostics while the writer owns the directory', async t => {
  const dir = await directory(t);
  const lab = new ExperimentLab(dir);
  await lab.init();
  t.after(() => lab.close());
  const draft = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  const lock = await readFile(join(dir, '.lock'), 'utf8');
  await writeFile(join(dir, 'damaged.json'), '{broken');
  const reader = new ExperimentStore(dir);
  assert.equal((await reader.get(draft.id)).id, draft.id);
  assert.equal((await reader.list()).length, 1);
  assert.deepEqual(reader.diagnostics, [{ id: 'damaged', message: 'Некорректный JSON. Исходный файл сохранён.' }]);
  assert.equal(await readFile(join(dir, 'damaged.json'), 'utf8'), '{broken');
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), lock);
  await assert.rejects(reader.save(await reader.get(draft.id)), /как писатель/);
  await assert.rejects(reader.init(), /already open/);
  await reader.close();
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), lock);
  await rm(join(dir, 'damaged.json'));
  await reader.list(); assert.deepEqual(reader.diagnostics, []);
  assert.deepEqual(await new ExperimentStore(join(dir, 'missing')).list(), []);
});

test('ambiguous recovery gates and malformed owner records are preserved', async t => {
  const dir = await directory(t);
  const dead = JSON.stringify({ pid: 2147483647, token: 'dead' });
  await writeFile(join(dir, '.lock'), dead);
  await writeFile(join(dir, '.recovery'), 'previous recovery needs inspection');
  await assert.rejects(new ExperimentStore(dir).init(), /Восстановление уже занято/);
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), dead);
  await rm(join(dir, '.recovery'));
  await writeFile(join(dir, '.lock'), '{unfinished');
  await assert.rejects(new ExperimentStore(dir).init(), /Некорректный lock/);
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), '{unfinished');
});

test('simultaneous real processes recover a dead writer without stealing the winner lock', { timeout: 15000 }, async t => {
  const dir = await directory(t);
  await writeFile(join(dir, '.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const source = new URL('../src/store.ts', import.meta.url).href;
  const script = `
    import { ExperimentStore } from ${JSON.stringify(source)};
    import { createInterface } from 'node:readline';
    const store = new ExperimentStore(process.argv[1]);
    const input = createInterface({ input: process.stdin });
    let started = false;
    input.on('line', async () => {
      if (started) { await store.close(); input.close(); process.exit(0); }
      started = true;
      try { await store.init(); process.stdout.write('locked\\n'); }
      catch (error) { process.stdout.write('blocked: ' + error.message + '\\n'); input.close(); process.exit(0); }
    });
    process.stdout.write('ready\\n');
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) child.kill(); });
  const next = children.map(lines);
  const exits = children.map(child => new Promise<number | null>(resolve => child.on('close', resolve)));
  assert.deepEqual(await Promise.all(next.map(read => read())), ['ready', 'ready', 'ready', 'ready']);
  children.forEach(child => child.stdin.write('start\n'));
  const results = await Promise.all(next.map(read => read()));
  assert.equal(results.filter(line => line === 'locked').length, 1, results.join('\n'));
  assert.equal(results.filter(line => line.startsWith('blocked:')).length, 3, results.join('\n'));
  const winner = results.indexOf('locked');
  const lock = JSON.parse(await readFile(join(dir, '.lock'), 'utf8'));
  assert.equal(lock.pid, children[winner]!.pid); assert.notEqual(lock.token, 'dead');
  await assert.rejects(new ExperimentStore(dir).init(), /already open/);
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.lock'), 'utf8')), lock);
  children[winner]!.stdin.write('close\n');
  assert.deepEqual(await Promise.all(exits), [0, 0, 0, 0]);
  await assert.rejects(readFile(join(dir, '.lock')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(dir, '.recovery')), { code: 'ENOENT' });
});

test('CLI export and diff read snapshots without interrupting a live writer', { timeout: 15000 }, async t => {
  const dir = await directory(t);
  const lab = new ExperimentLab(dir); await lab.init(); t.after(() => lab.close());
  const draft = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  const lock = await readFile(join(dir, '.lock'), 'utf8');
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const call = async (args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--data-dir', dir, ...args]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    return { code, stdout, stderr };
  };
  const exported = await call(['export', '--id', before.id]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).experiment.id, before.id);
  const diff = await call(['diff', '--before', before.id, '--after', before.id, '--json']);
  assert.equal(diff.code, 2, diff.stderr); assert.equal(JSON.parse(diff.stdout).comparable, false);
  assert.equal(await readFile(join(dir, '.lock'), 'utf8'), lock);
  assert.deepEqual(await lab.get(before.id), before);
});
