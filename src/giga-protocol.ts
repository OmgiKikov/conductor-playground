interface CatalogEntry { id?: unknown; type?: unknown }

/*
 * Шлюз раздаёт не только чат: эмбеддинги и служебные модели чат-запрос не
 * обслуживают. Отбор идёт по полю type, без эвристик по именам моделей;
 * шлюз, который его не присылает вовсе, отдаёт весь каталог.
 */
export function parseCatalog(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const entries = data as CatalogEntry[];
  const typed = entries.some(entry => typeof entry.type === 'string');
  return entries
    .filter(entry => typeof entry.id === 'string' && (!typed || entry.type === 'chat'))
    .map(entry => entry.id as string);
}
