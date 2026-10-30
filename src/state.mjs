import { mkdir, readFile, rename, readdir, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const lockfile = createRequire(import.meta.url)('proper-lockfile');
import { hash } from './pi-session.mjs';

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
}

export class Store {
  constructor(root, server) {
    this.directory = join(root, hash(server));
    this.queue = join(this.directory, 'queue');
  }
  async init() {
    await mkdir(this.queue, { recursive: true, mode: 0o700 });
  }
  statePath(key) { return join(this.directory, `${hash(key)}.json`); }
  async load(key) {
    try {
      const state = JSON.parse(await readFile(this.statePath(key), 'utf8'));
      if (state.schema !== 1) throw new Error('state_unsupported');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('state_invalid');
    }
  }
  async save(key, state) { await atomicJson(this.statePath(key), { ...state, schema: 1 }); }
  async enqueue(request) {
    // A separate short lock orders controls independently of model latency and clocks.
    const release = await lockfile.lock(this.queue, {
      realpath: false, retries: { retries: 100, factor: 1, minTimeout: 20, maxTimeout: 20 },
    });
    try {
      const counterPath = join(this.directory, 'queue-sequence.json');
      let sequence = 0n;
      try { sequence = BigInt(JSON.parse(await readFile(counterPath, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('queue_invalid_sequence'); }
      sequence++;
      await atomicJson(counterPath, sequence.toString());
      const id = `${sequence.toString().padStart(24, '0')}.json`;
      await atomicJson(join(this.queue, id), request);
      return id;
    } finally { await release(); }
  }
  async requests() {
    const names = (await readdir(this.queue)).filter((name) => name.endsWith('.json')).sort();
    return Promise.all(names.map(async (id) => ({ id, ...JSON.parse(await readFile(join(this.queue, id), 'utf8')) })));
  }
  async remove(id) { await unlink(join(this.queue, id)); }
  async hasControl(terminalId, exceptId) {
    return (await this.requests()).some((r) => r.id > exceptId && r.terminalId === terminalId && r.action !== 'check');
  }
  async targetLock(terminalId) {
    const directory = join(this.directory, `target-${hash(terminalId)}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return lockfile.lock(directory, {
      realpath: false, stale: 30000, update: 5000,
      retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  }
  async lock() {
    // Every invocation waits for the lock, so an event arriving at worker exit
    // still drains its own durable request instead of losing the final wakeup.
    let compromised = false;
    const release = await lockfile.lock(this.directory, {
      realpath: false, stale: 30000, update: 5000,
      retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 500 },
      onCompromised: () => { compromised = true; },
    });
    return { release, assert: () => { if (compromised) throw new Error('lock_compromised'); } };
  }
}

export function safeError(error) {
  // Never print paths, task text, child stderr, HTTP bodies, or credentials.
  const message = error?.message ?? '';
  return /^(?:session|state|model|config|name|target|rename|lock|request|queue)_[a-z0-9_]+$/.test(message)
    ? message : 'operation_failed';
}
