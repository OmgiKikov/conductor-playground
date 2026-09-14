import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Console } from 'node:console';

// One process per dialogue also clears the import cache between agent versions.
// Adapter console output is diagnostic; stdout belongs to the JSON protocol.
globalThis.console = new Console(process.stderr);
let session;
try {
  const mod = await import(pathToFileURL(process.argv[2]).href);
  const factory = mod[process.argv[3]];
  if (typeof factory !== 'function') throw new Error(`Module adapter has no function export named ${process.argv[3]}`);
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.type === 'open') {
      session = await factory({ sessionId: request.sessionId, scenarioId: request.scenarioId, initialState: request.initialState, prompt: request.prompt, promptHash: request.promptHash });
      if (typeof session?.respond !== 'function') throw new Error('Module adapter must return a session with respond(message, messages).');
      process.stdout.write('""\n');
    } else if (request.type === 'close') break;
    else if (request.type === 'respond' && session) {
      const reply = await session.respond(request.message, request.messages);
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    } else throw new Error('Unexpected module protocol message');
  }
  await session?.close?.();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
}
