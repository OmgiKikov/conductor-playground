import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { dialogueSchema, goldenCaseSchema } from './contracts.js';

/** Local JSON arrays or one validated item per JSONL line. Origin labels are assigned later by ExperimentLab. */
export async function readData(file: string, kind: 'golden' | 'dialogues') {
  if ((await stat(file)).size > 4_000_000) throw new Error('Файл импорта превышает 4 МБ. Выберите меньшую выборку.');
  const text = await readFile(file, 'utf8');
  const data: unknown = file.endsWith('.jsonl') ? text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Некорректный JSON в строке ${i + 1}.`); }
  }) : JSON.parse(text);
  return kind === 'golden' ? z.array(goldenCaseSchema).min(1).max(40).parse(data) : z.array(dialogueSchema).min(1).max(200).parse(data);
}
