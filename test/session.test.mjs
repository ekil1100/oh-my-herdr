import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { parseSession, readSession, resolveSessionPath, resolveKimiSessionPath } from '../src/session.mjs';

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

// Shapes from MoonshotAI/kimi-code @moonshot-ai/kimi-code@2.3.3:
// contextEvents.ts, loopEventFold.ts, wire/tree/fork.ts, sessionMetadata.ts.
const metadata = { type: 'metadata', protocol_version: '1.5', created_at: 1793394000000 };
const kimiMessage = (id, role, text, origin) => ({ type: 'context.append_message', agentId: 'main',
  time: 1793394000100, message: { id, role, content: [{ type: 'text', text }], toolCalls: [], ...(origin ? { origin } : {}) } });
const loop = (event, agentId = 'main') => ({ type: 'context.append_loop_event', agentId, time: 1793394000200, event });
const step = (uuid, text) => [loop({ type: 'step.begin', uuid, turnId: '0', step: 1 }),
  loop({ type: 'content.part', uuid: `${uuid}-text`, stepUuid: uuid, turnId: '0', step: 1, part: { type: 'text', text } }),
  loop({ type: 'step.end', uuid, turnId: '0', step: 1, finishReason: 'stop', messageId: `${uuid}-provider` })];
const parseWire = (records, tail = '') => parseSession(jsonl([metadata, ...records]) + tail, 'kimi', 'session');
const texts = (snapshot) => snapshot.messages.map((message) => message.text);

test('Kimi 2.3.3 folds persisted text parts once and excludes private or synthetic content', () => {
  const records = [
    kimiMessage('u1', 'user', 'Fix login', { kind: 'user' }),
    { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'Fix login' }], promptId: 'u1' },
    loop({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }),
    loop({ type: 'content.part', uuid: 'think', stepUuid: 's1', part: { type: 'think', think: 'private reasoning' } }),
    loop({ type: 'content.part', uuid: 'text1', stepUuid: 's1', part: { type: 'text', text: 'Fixed ' } }),
    loop({ type: 'content.part', uuid: 'text1', stepUuid: 's1', part: { type: 'text', text: 'Fixed ' } }),
    loop({ type: 'content.part', uuid: 'text2', stepUuid: 's1', part: { type: 'text', text: 'login.' } }),
    loop({ type: 'content.part', uuid: 'image', stepUuid: 's1', part: { type: 'image_url', image_url: { url: 'private' } } }),
    loop({ type: 'tool.call', uuid: 'call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: { command: 'private' } }),
    loop({ type: 'tool.result', parentUuid: 'call', toolCallId: 'tc1', result: { output: 'private result' } }),
    loop({ type: 'step.end', uuid: 's1', finishReason: 'tool_calls' }),
    kimiMessage('inject', 'user', 'System reminder', { kind: 'injection', ownerPromptId: 'u1' }),
    kimiMessage('summary', 'user', 'Synthetic summary', { kind: 'compaction_summary' }),
    kimiMessage('hook', 'assistant', 'Hook output', { kind: 'hook_result', event: 'UserPromptSubmit' }),
    kimiMessage('task', 'user', 'Subagent notification', { kind: 'task', taskId: 'child' }),
    kimiMessage('retry', 'user', 'Retry instructions', { kind: 'retry' }),
    kimiMessage('timer', 'user', 'Internal continuation', { kind: 'system_trigger', name: 'goal_continuation' }),
    { ...kimiMessage('child', 'user', 'Child goal'), agentId: 'child' },
    ...step('child-step', 'Child answer').map((record) => ({ ...record, agentId: 'child' })),
  ];
  const result = parseWire(records);
  assert.deepEqual(texts(result), ['Fix login', 'Fixed login.']);
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant']);
  const toolOnly = loop({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'More private output' } });
  assert.equal(parseWire([...records, toolOnly]).version, result.version);
});

test('Kimi partial text changes message identity; incomplete JSON is deferred', () => {
  const records = [kimiMessage('u1', 'user', 'Fix login'),
    loop({ type: 'step.begin', uuid: 's1' }),
    loop({ type: 'content.part', uuid: 'p1', stepUuid: 's1', part: { type: 'text', text: 'Fixing' } })];
  const before = parseWire(records, '{"type":"context.append_loop_event"');
  assert.equal(before.partial, true);
  const after = parseWire([...records, loop({ type: 'content.part', uuid: 'p2', stepUuid: 's1',
    part: { type: 'text', text: ' login' } })]);
  assert.deepEqual(texts(after), ['Fix login', 'Fixing login']);
  assert.equal(after.messages[0].id, before.messages[0].id);
  assert.notEqual(after.messages[1].id, before.messages[1].id);
  assert.notEqual(after.version, before.version);
});

test('Kimi repeated message/event IDs do not duplicate replay while equal text in new turns survives', () => {
  const user = kimiMessage('u1', 'user', 'Continue');
  const records = [user, user, ...step('s1', 'Done'), ...step('s1', 'Done'),
    kimiMessage('u2', 'user', 'Continue'), ...step('s2', 'Done')];
  const result = parseWire(records);
  assert.deepEqual(texts(result), ['Continue', 'Done', 'Continue', 'Done']);
  assert.equal(new Set(result.messages.map((message) => message.id)).size, 4);
});

test('Kimi accepts persisted assistant messages and user slash prompts, and filters automatic skill injection', () => {
  const result = parseWire([
    kimiMessage('u', 'user', '/review', { kind: 'skill_activation', trigger: 'user-slash' }),
    kimiMessage('context', 'user', 'Skill instructions', { kind: 'skill_activation', trigger: 'tool' }),
    kimiMessage('a', 'assistant', 'Reviewed'),
    kimiMessage('p', 'user', '/plugin', { kind: 'plugin_command', trigger: 'user-slash' }),
  ]);
  assert.deepEqual(texts(result), ['/review', 'Reviewed', '/plugin']);
});

test('Kimi legacy undo counts user anchors, discards orphan parts, and allows replay of undone IDs', () => {
  const second = [kimiMessage('u2', 'user', 'Abandoned'), ...step('s2', 'Old answer')];
  const base = [kimiMessage('u1', 'user', 'Keep this'), ...step('s1', 'Kept answer')];
  const undo = { type: 'context.undo', agentId: 'main', count: 1 };
  const records = [...base, ...second,
    kimiMessage('steer', 'user', 'In-turn steering', { kind: 'user', inTurn: true }),
    kimiMessage('notify', 'user', 'System continuation', { kind: 'system_trigger', name: 'subagent' }), undo,
    loop({ type: 'content.part', uuid: 'late', stepUuid: 's2', part: { type: 'text', text: 'Late old answer' } })];
  assert.deepEqual(texts(parseWire(records)), ['Keep this', 'Kept answer']);
  assert.deepEqual(texts(parseWire([...records, ...second])), ['Keep this', 'Kept answer', 'Abandoned', 'Old answer']);
  assert.deepEqual(texts(parseWire([...base, ...second, { ...undo, count: 2 }])), []);
  assert.throws(() => parseWire([...base, { ...undo, count: -1 }]), /session_unsupported_format/);
});

test('Kimi compaction and context clear retain dialogue and form legacy undo boundaries', () => {
  const base = [kimiMessage('u1', 'user', 'Original goal'), ...step('s1', 'Original answer')];
  for (const boundary of [
    { type: 'context.apply_compaction', agentId: 'main', summary: 'Synthetic summary', compactedCount: 2, keptUserMessageCount: 1 },
    { type: 'context.clear', agentId: 'main' },
  ]) {
    const result = parseWire([...base, boundary,
      kimiMessage('u2', 'user', 'New turn'), ...step('s2', 'New answer'),
      { type: 'context.undo', agentId: 'main', count: 2 }]);
    assert.deepEqual(texts(result), ['Original goal', 'Original answer']);
    assert.equal(result.version, parseWire(base).version);
  }
});

test('Kimi interrupted steps retain partial text and later steps reject stale content', () => {
  const result = parseWire([kimiMessage('u1', 'user', 'Fix login'),
    loop({ type: 'step.begin', uuid: 's1' }),
    loop({ type: 'content.part', uuid: 'p1', stepUuid: 's1', part: { type: 'text', text: 'Partial' } }),
    loop({ type: 'step.end', uuid: 's1', finishReason: 'interrupted' }),
    loop({ type: 'content.part', uuid: 'p2', stepUuid: 's1', part: { type: 'text', text: ' response' } }),
    loop({ type: 'step.begin', uuid: 's2' }),
    loop({ type: 'content.part', uuid: 'late', stepUuid: 's1', part: { type: 'text', text: 'Ignored' } }),
    loop({ type: 'content.part', uuid: 'p3', stepUuid: 's2', part: { type: 'text', text: 'Final' } }),
    loop({ type: 'step.end', uuid: 's2', finishReason: 'stop' }),
    loop({ type: 'content.part', uuid: 'p4', stepUuid: 's2', part: { type: 'text', text: 'Ignored after end' } })]);
  assert.deepEqual(texts(result), ['Fix login', 'Partial response', 'Final']);
});

test('Kimi branch rollback selects physical base lines and skips the paired legacy undo', () => {
  // Includes the metadata line: u1=2, s1=3..5, u2=6, s2=7..9, switch=10.
  const records = [kimiMessage('u1', 'user', 'Keep'), ...step('s1', 'Kept'),
    kimiMessage('u2', 'user', 'Discard'), ...step('s2', 'Discarded'),
    { type: 'agent.switched', agentId: 'main', branch: 'fork-a', base: { branch: 'main', line: 5 },
      reason: 'undo', turns: 1, legacyUndoLine: 11 },
    { type: 'context.undo', agentId: 'main', count: 1 },
    { type: 'context.undone', agentId: 'main', turns: 1, fromTurnId: 1 },
    kimiMessage('u3', 'user', 'Replacement'), ...step('s3', 'Replacement answer')];
  const result = parseWire(records);
  assert.deepEqual(texts(result), ['Keep', 'Kept', 'Replacement', 'Replacement answer']);
  assert.deepEqual(result.messages.slice(0, 2), parseWire(records.slice(0, 4)).messages);
  // The switch itself is sufficient even if the following records have not yet been appended.
  assert.deepEqual(texts(parseWire(records.slice(0, 9))), ['Keep', 'Kept']);
});

test('Kimi nested switches can restore an abandoned branch without replaying another branch', () => {
  const records = [kimiMessage('u1', 'user', 'First'), kimiMessage('u2', 'user', 'Second'),
    { type: 'agent.switched', agentId: 'main', branch: 'a', base: { branch: 'main', line: 2 } },
    kimiMessage('u3', 'user', 'Branch A'),
    { type: 'agent.switched', agentId: 'main', branch: 'b', base: { branch: 'a', line: 5 } },
    kimiMessage('u4', 'user', 'Branch B')];
  assert.deepEqual(texts(parseWire(records)), ['First', 'Branch A', 'Branch B']);
  records.push({ type: 'agent.switched', agentId: 'main', branch: 'c', base: { branch: 'main', line: 3 } },
    kimiMessage('u5', 'user', 'Restored main'));
  assert.deepEqual(texts(parseWire(records)), ['First', 'Second', 'Restored main']);
});

test('Kimi branch line references include empty physical lines', () => {
  const text = jsonl([metadata, kimiMessage('u1', 'user', 'Keep')]) + '\n' + jsonl([
    kimiMessage('u2', 'user', 'Discard'),
    { type: 'agent.switched', agentId: 'main', branch: 'a', base: { branch: 'main', line: 3 } },
  ]);
  assert.deepEqual(texts(parseSession(text, 'kimi', 'session')), ['Keep']);
});

test('Kimi rejects invalid branch references and unsupported wire protocols', () => {
  for (const base of [{ branch: 'missing', line: 1 }, { branch: 'main', line: 99 }, { branch: 'main', line: -1 }]) {
    assert.throws(() => parseWire([{ type: 'agent.switched', branch: 'a', base }]), /session_invalid_tree/);
  }
  assert.throws(() => parseWire([{ type: 'agent.switched', branch: 'main', base: { branch: 'main', line: 1 } }]), /session_invalid_tree/);
  assert.throws(() => parseSession(jsonl([{ ...metadata, protocol_version: '99' }]), 'kimi', 'session'), /session_unsupported_format/);
});

test('Kimi reads current main wire identity from state.json and rejects subagent or mismatched paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'oh-my-herdr-kimi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'sessions', 'workspace-key', 'session');
  const path = join(directory, 'agents', 'main', 'wire.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify({ id: 'session', version: 2, createdAt: 1, updatedAt: 1,
    archived: false, agents: { main: { type: 'main' } } }));
  await writeFile(path, jsonl([metadata, kimiMessage('u1', 'user', 'Fix login'), ...step('s1', 'Done')]));
  const snapshot = await readSession(path, 'kimi');
  assert.equal(snapshot.sessionId, 'session');
  assert.deepEqual(texts(snapshot), ['Fix login', 'Done']);
  assert.equal(await resolveKimiSessionPath('session', { KIMI_CODE_HOME: root }), path);
  await assert.rejects(readSession(join(directory, 'agents', 'child', 'wire.jsonl'), 'kimi'), /session_identity_mismatch/);
  await writeFile(statePath, JSON.stringify({ id: 'another', version: 2 }));
  await assert.rejects(readSession(path, 'kimi'), /session_identity_mismatch/);
  await assert.rejects(resolveKimiSessionPath('session', { KIMI_CODE_HOME: root }), /session_identity_mismatch/);
});

test('Kimi exact resolver defaults to HOME/.kimi-code and rejects duplicate IDs even with an invalid duplicate state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'oh-my-herdr-kimi-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.kimi-code', 'sessions');
  const directory = join(root, 'workspace-a', 'session');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'state.json'), JSON.stringify({ id: 'session', version: 2 }));
  assert.equal(await resolveKimiSessionPath('session', { HOME: home }), join(directory, 'agents', 'main', 'wire.jsonl'));
  await mkdir(join(root, 'workspace-b', 'session'), { recursive: true });
  await assert.rejects(resolveKimiSessionPath('session', { HOME: home }), /session_identity_ambiguous/);
});

test('Kimi replayed old step boundaries cannot close the current step', () => {
  const result = parseWire([kimiMessage('u1', 'user', 'First'), ...step('s1', 'First answer'),
    kimiMessage('u2', 'user', 'Second'), loop({ type: 'step.begin', uuid: 's2' }),
    loop({ type: 'content.part', uuid: 's2-a', stepUuid: 's2', part: { type: 'text', text: 'Second ' } }),
    ...step('s1', 'First answer'),
    loop({ type: 'content.part', uuid: 's2-b', stepUuid: 's2', part: { type: 'text', text: 'answer' } }),
    loop({ type: 'step.end', uuid: 's2', finishReason: 'stop' })]);
  assert.deepEqual(texts(result), ['First', 'First answer', 'Second', 'Second answer']);
});
