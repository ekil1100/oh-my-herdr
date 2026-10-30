import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classify, loadConfig, redact, uniqueName, validateDecision } from '../src/naming.mjs';
import { Store, safeError } from '../src/state.mjs';

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'auto-name-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('model input is minimized and known secrets are redacted; output validated', async () => {
  let payload;
  const result = await classify({ newMessages: [{ text: 'api_key=secret sk-abcdefghijkl' }] }, {
    baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'private-value',
  }, async (url, options) => {
    assert.equal(url, 'https://example.com/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      decision: 'new_task', summary: 'Fix login', name: 'fix-login',
    }) } }] }));
  });
  assert.equal(result.name, 'fix-login');
  assert.doesNotMatch(payload.messages[1].content, /secret|sk-abcdefgh/);
  assert.throws(() => validateDecision({ decision: 'new_task', summary: 'x', name: 'a;rm' }), /invalid_output/);
  assert.equal(redact('token private-value', ['private-value']), 'token [REDACTED]');
});

test('model failures are bounded and never include provider bodies', async () => {
  const config = { baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'key' };
  await assert.rejects(classify({}, config, async () => new Response('secret diagnostic', { status: 401 })), /^Error: model_http_401$/);
  await assert.rejects(classify({}, config, async () => new Response('bad')), /invalid_output/);
  await assert.rejects(classify({ text: 'x'.repeat(25000) }, config), /input_limit/);
});

test('config requires explicit credentials and HTTPS except loopback', async (t) => {
  const directory = await temp(t);
  const config = { provider: 'deepseek', baseUrl: 'http://localhost:1234/v1', model: 'test' };
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
  assert.equal((await loadConfig(directory, { DEEPSEEK_API_KEY: 'key' })).apiKey, 'key');
  await assert.rejects(loadConfig(directory, {}), /credentials_missing/);
  await writeFile(join(directory, 'config.json'), JSON.stringify({ ...config, baseUrl: 'http://example.com' }));
  await assert.rejects(loadConfig(directory, { DEEPSEEK_API_KEY: 'key' }), /config_invalid/);
});

test('long colliding names remain valid', () => {
  const base = 'a'.repeat(32);
  assert.equal(uniqueName(base, [{ pane_id: 'other', name: base }], 'mine', () => 'abcd'), 'a'.repeat(27) + '-abcd');
});

test('durable requests survive store recreation; permissions and control detection', async (t) => {
  const directory = await temp(t);
  const store = new Store(directory, 'server'); await store.init();
  await store.save('session', { schema: 1, summary: 'task' });
  const id = await store.enqueue({ terminalId: 't1', action: 'pause' });
  const restored = new Store(directory, 'server');
  assert.equal((await restored.load('session')).summary, 'task');
  assert.equal(await restored.hasControl('t1', '0'), true);
  assert.equal(await restored.hasControl('t1', id), false);
  assert.equal((await stat(restored.statePath('session'))).mode & 0o777, 0o600);
  const second = await restored.enqueue({ terminalId: 't1', action: 'resume' });
  assert.ok(second > id);
  assert.equal(await restored.hasControl('t1', second), false);
  assert.deepEqual((await restored.requests()).map((r) => r.id), [id, second]);
  await restored.remove(id);
  await restored.remove(second);
  assert.deepEqual(await restored.requests(), []);
  assert.equal(safeError(new Error('secret /home/user')), 'operation_failed');
});

test('concurrent invocations serialize and final queued request remains visible', async (t) => {
  const directory = await temp(t);
  const first = new Store(directory, 'server'); await first.init();
  const second = new Store(directory, 'server');
  const lock1 = await first.lock();
  let acquired = false;
  const pending = second.lock().then((lock) => { acquired = true; return lock; });
  await second.enqueue({ terminalId: 't1', action: 'check' });
  assert.equal(acquired, false);
  await lock1.release();
  const lock2 = await pending;
  assert.equal((await second.requests()).length, 1);
  await lock2.release();
});
