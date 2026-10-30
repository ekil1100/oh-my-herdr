import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSession, readSession } from '../src/pi-session.mjs';

const header = { type: 'session', version: 3, id: 'session' };
const user = (id, parentId, content) => ({ type: 'message', id, parentId, message: { role: 'user', content } });
const jsonl = (...entries) => [header, ...entries].map(JSON.stringify).join('\n') + '\n';

test('reads user and assistant text on the persisted branch, excluding custom messages', () => {
  const snapshot = parseSession(jsonl(
    user('a', null, 'Fix login'),
    user('b', 'a', 'Unrelated branch'),
    { type: 'custom_message', id: 'c', parentId: 'a', content: 'Injected custom message' },
    { type: 'message', id: 'd', parentId: 'c', message: { role: 'assistant', content: 'Response' } },
    user('e', 'd', [{ type: 'image', data: 'secret' }, { type: 'text', text: 'Add tests' }]),
  ));
  assert.deepEqual(snapshot.messages, [{ id: 'a', role: 'user', text: 'Fix login' }, { id: 'd', role: 'assistant', text: 'Response' }, { id: 'e', role: 'user', text: 'Add tests' }]);
  assert.equal(snapshot.activeLeaf, 'unknown');
});

test('ignores incomplete trailing records and handles image-only input', () => {
  const snapshot = parseSession(jsonl(user('a', null, [{ type: 'image', data: 'blob' }])) + '{"type":');
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.messages[0].text, '');
});

test('rejects unsupported versions, malformed complete rows, duplicates and broken links', () => {
  assert.throws(() => parseSession('{"type":"session","version":2,"id":"x"}\n'), /unsupported/);
  assert.throws(() => parseSession(jsonl() + 'bad\n'), /invalid_json/);
  assert.throws(() => parseSession(jsonl(user('a', 'missing', 'task'))), /invalid_tree/);
  assert.throws(() => parseSession(jsonl(user('a', null, 'task'), user('a', 'a', 'other'))), /invalid_tree/);
});

test('metadata appends do not change task version', () => {
  const text = jsonl(user('a', null, 'Task'));
  const appended = text + JSON.stringify({ type: 'usage', id: 'b', parentId: 'a' }) + '\n';
  assert.equal(parseSession(text).version, parseSession(appended).version);
});

test('file replacement and truncation are reread, without modifying session', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'auto-name-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, jsonl(user('a', null, 'Task')));
  const before = await readSession(path);
  await writeFile(join(dir, 'replacement'), jsonl(user('z', null, 'New task')));
  await rename(join(dir, 'replacement'), path);
  const after = await readSession(path);
  assert.notEqual(after.fileIdentity, before.fileIdentity);
  assert.deepEqual(after.messages, [{ id: 'z', role: 'user', text: 'New task' }]);
  await writeFile(path, jsonl());
  assert.deepEqual((await readSession(path)).messages, []);
});


test('assistant text updates the version while thinking and tools are excluded', () => {
  const initial = user('a', null, 'Help with login');
  const reply = { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Private reasoning' },
    { type: 'toolCall', name: 'bash', arguments: {} },
    { type: 'text', text: 'Check the login handler' },
  ] } };
  const snapshot = parseSession(jsonl(initial, reply));
  assert.notEqual(snapshot.version, parseSession(jsonl(initial)).version);
  assert.deepEqual(snapshot.messages[1], { id: 'b', role: 'assistant', text: 'Check the login handler' });
  const tool = { type: 'message', id: 'c', parentId: 'b', message: { role: 'toolResult', content: 'Tool output' } };
  const thinking = { type: 'message', id: 'd', parentId: 'c', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hidden' }] } };
  assert.equal(parseSession(jsonl(initial, reply, tool, thinking)).version, snapshot.version);
});
