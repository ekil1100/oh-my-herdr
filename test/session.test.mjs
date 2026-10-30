import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { parseSession, readSession, resolveSessionPath } from '../src/session.mjs';

const jsonl = (records) => records.map(JSON.stringify).join('\n') + '\n';
const claude = (id, parentUuid, role, content, extra = {}) => ({ type: role, uuid: id, parentUuid,
  sessionId: 'session', message: { role, content }, ...extra });
const codex = (role, text) => ({ type: 'response_item', payload: { type: 'message', role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('Claude follows the latest branch and excludes tools, sidechains and synthetic context', () => {
  const records = [claude('u1', null, 'user', 'Fix login'), claude('a1', 'u1', 'assistant', 'Old answer'),
    claude('u2', 'a1', 'user', 'Abandoned goal'), claude('a2', 'u1', 'assistant', [{ type: 'text', text: 'New answer' }, { type: 'thinking', thinking: 'private' }]),
    claude('t', 'a2', 'user', [{ type: 'tool_result', content: 'private output' }]),
    claude('meta', 't', 'user', 'Injected context', { isMeta: true }),
    claude('side', null, 'user', 'Side task', { isSidechain: true })];
  const snapshot = parseSession(jsonl(records) + '{"unfinished":', 'claude', 'session');
  assert.deepEqual(snapshot.messages.map((m) => m.text), ['Fix login', 'New answer']);
  assert.equal(snapshot.partial, true);
  records.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'meta' },
    claude('summary', 'boundary', 'user', 'Synthetic summary', { isCompactSummary: true }));
  assert.deepEqual(parseSession(jsonl(records), 'claude', 'session').messages, snapshot.messages);
  assert.throws(() => parseSession(jsonl(records), 'claude', 'other'), /session_identity_mismatch/);
});

test('Codex reads conversation once, preserves goals across compaction and applies rollback', () => {
  const records = [{ type: 'session_meta', payload: { id: 'session' } },
    codex('user', '# AGENTS.md instructions for /tmp'), codex('user', 'Fix login'), codex('assistant', 'Done'),
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Done' } },
    { type: 'compacted', payload: { replacement_history: [{ role: 'user', content: 'Synthetic summary' }] } },
    codex('user', 'Abandoned task'), codex('assistant', 'Abandoned answer'),
    { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }];
  assert.deepEqual(parseSession(jsonl(records), 'codex', 'session').messages.map((m) => m.text), ['Fix login', 'Done']);
  assert.throws(() => parseSession(jsonl(records), 'codex', 'other'), /session_identity_mismatch/);
});

test('Kimi reads text and detects rewritten context through message identities', () => {
  const records = [{ role: '_system_prompt', content: 'private' }, { role: '_checkpoint', id: 0 },
    { role: 'user', content: 'Fix login' }, { role: 'tool', content: 'private' },
    { role: 'assistant', content: [{ type: 'think', think: 'private' }, { type: 'text', text: 'Done' }] }];
  const before = parseSession(jsonl(records), 'kimi', 'session');
  assert.deepEqual(before.messages.map((m) => m.text), ['Fix login', 'Done']);
  records[2].content = 'Fix payment';
  const after = parseSession(jsonl(records), 'kimi', 'session');
  assert.notEqual(before.messages[0].id, after.messages[0].id);
  assert.notEqual(before.version, after.version);
});

for (const agent of ['claude', 'codex', 'kimi']) {
  test(`${agent}: reads only the explicitly bound absolute session file`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'auto-name-session-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), KIMI_SHARE_DIR: join(root, 'kimi') };
    const relative = { claude: 'claude/projects/project/session.jsonl', codex: 'codex/sessions/2026/01/01/rollout-date-session.jsonl.zst', kimi: 'kimi/sessions/project/session/context.jsonl' }[agent];
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    const text = jsonl({ claude: [claude('u1', null, 'user', 'Fix login')],
      codex: [{ type: 'session_meta', payload: { id: 'session' } }, codex('user', 'Fix login')],
      kimi: [{ role: 'user', content: 'Fix login' }] }[agent]);
    await writeFile(path, agent === 'codex' ? zstdCompressSync(Buffer.from(text)) : text);
    assert.equal(await resolveSessionPath(path, agent, env), path);
    assert.equal((await readSession(path, agent, env)).messages[0].text, 'Fix login');
    assert.equal((await readSession(path, agent, env)).sessionId, 'session');
    await assert.rejects(resolveSessionPath('../session', agent, env), /session_nonlocal_path/);
    await assert.rejects(readSession('session', agent, env), /session_nonlocal_path/);
  });
}
