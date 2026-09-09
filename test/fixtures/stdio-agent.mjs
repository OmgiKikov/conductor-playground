// Test fixture for the command target: one JSON request per stdin line, one JSON reply per stdout line.
import readline from 'node:readline';

const mode = process.argv[2] ?? 'ok';
if (mode === 'crash') { console.error('agent crashed on purpose'); process.exit(3); }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'close') process.exit(0);
  if (mode === 'hang') return;
  const time = request.message.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0];
  const id = Object.keys(request.initialState.records)[0];
  if (id && time) {
    const records = structuredClone(request.initialState.records);
    records[id].time = time;
    process.stdout.write(`${JSON.stringify({ reply: `Moved ${id} to ${time}.`, events: [{ tool: 'update_record', args: { recordId: id, changes: { time } }, result: { ok: true, recordId: id } }], records })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(`You said: ${request.message} (${request.messages.length} earlier)`)}\n`);
  }
});
