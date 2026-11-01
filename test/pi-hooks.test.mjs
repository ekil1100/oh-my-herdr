import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { registerPiHooks } from '../src/pi-hooks.mjs';

function fixture(run, mode = 'tui') {
  const handlers = new Map(), calls = [];
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  registerPiHooks(pi, async (args) => { calls.push(args); return run?.(args); }, { HC_TERMINAL_ID: 't1' });
  const context = (path) => ({ sessionManager: { getSessionFile: () => path }, hasUI: false, mode });
  const emit = (event, payload = {}, path = '/one.jsonl') => handlers.get(event)?.(payload, context(path));
  return { handlers, calls, emit };
}

test('Pi binds exact startup/resume files and invalidates old work before replacement', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  await f.emit('session_start', { reason: 'startup' });
  await delay(130);
  assert.deepEqual(f.calls, [['bind', 't1', 'pi', '/one.jsonl'], ['check', 't1', '--session', '/one.jsonl']]);
  await f.emit('session_shutdown', { reason: 'resume' });
  await f.emit('session_start', { reason: 'resume' }, '/two.jsonl');
  await delay(130);
  assert.deepEqual(f.calls.slice(2), [
    ['unbind', 't1', '--session', '/one.jsonl'], ['bind', 't1', 'pi', '/two.jsonl'],
    ['check', 't1', '--session', '/two.jsonl'],
  ]);
  await f.emit('session_shutdown', { reason: 'quit' });
});

test('Pi tool-only messages launch no checks; user/text lifecycle checks are coalesced', async () => {
  const f = fixture();
  await f.emit('session_start');
  await delay(130);
  await f.emit('message_end', { message: { role: 'toolResult', content: 'output' } });
  await f.emit('message_end', { message: { role: 'assistant', content: [{ type: 'toolCall' }] } });
  await delay(130);
  assert.equal(f.calls.length, 2);
  await f.emit('message_end', { message: { role: 'user', content: 'Fix login' } });
  await f.emit('agent_start');
  await f.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } });
  await f.emit('agent_end');
  await f.emit('agent_settled');
  await delay(130);
  assert.equal(f.calls.length, 3);
  await f.emit('session_shutdown', { reason: 'reload' });
  assert.equal(f.calls.length, 3);
});

test('Pi session switch proceeds while model check is pending; new session gets a follow-up', async () => {
  let finish;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const f = fixture((args) => args[0] === 'check' && args.at(-1) === '/one.jsonl' ? blocked : undefined);
  await f.emit('session_start');
  await delay(130);
  assert.equal(f.calls.length, 2);
  await f.emit('session_shutdown', { reason: 'new' });
  await f.emit('session_start', { reason: 'new' }, '/two.jsonl');
  await delay(130);
  assert.equal(f.calls.length, 4);
  finish();
  await delay(10);
  assert.deepEqual(f.calls.at(-1), ['check', 't1', '--session', '/two.jsonl']);
  await f.emit('session_shutdown', { reason: 'quit' });
});

test('Pi headless children do not replace the terminal binding', async () => {
  for (const mode of ['rpc', 'print', 'json']) {
    const f = fixture(undefined, mode);
    await f.emit('session_start');
    await f.emit('agent_start');
    await f.emit('session_shutdown', { reason: 'new' });
    await delay(130);
    assert.deepEqual(f.calls, []);
  }
});

test('Pi without HC_TERMINAL_ID or a persistent session launches no CLI', async () => {
  const registrations = [];
  registerPiHooks({ on: (...args) => registrations.push(args) }, () => { throw new Error('unexpected'); }, {});
  assert.deepEqual(registrations, []);
  const f = fixture();
  await f.emit('session_start', {}, null);
  await f.emit('agent_start');
  await delay(130);
  assert.deepEqual(f.calls, []);
  await f.emit('session_shutdown', { reason: 'quit' });
});
