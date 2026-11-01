import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { zstdCompressSync } from 'node:zlib';
import { processHookEvent, hookMain } from '../src/agent-hook.mjs';
import { main } from '../src/main.mjs';
import { Store } from '../src/state.mjs';

const cli = fileURLToPath(new URL('../src/agent-hook.mjs', import.meta.url));
const jsonl = (records) => records.map(JSON.stringify).join('\n') + '\n';
const transcript = (agent, id) => jsonl(agent === 'claude' ? [
  { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, isSidechain: false,
    message: { role: 'user', content: 'Fix login' } },
] : [{ type: 'session_meta', payload: { id, source: 'cli' } }]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'oh-my-herdr-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, HC_TERMINAL_ID: 't1', HC_SESSION: 'hook-test',
    OH_MY_HERDR_HOME: join(root, 'home'), KIMI_CODE_HOME: join(root, 'kimi') };
  delete env.CODEX_THREAD_ID;
  const calls = [];
  const checks = [];
  const options = { env, run: async (args, received) => { assert.equal(received, env); calls.push(args); },
    schedule: async (args, received) => { assert.equal(received, env); checks.push(args); } };
  const write = async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); };
  const event = async (agent, id = 'session', name = 'SessionStart') => {
    let path;
    if (agent === 'kimi') {
      const directory = join(env.KIMI_CODE_HOME, 'sessions', 'workspace-key', id);
      await write(join(directory, 'state.json'), JSON.stringify({ id, version: 2, createdAt: 1, updatedAt: 1,
        archived: false, cwd: '/original/workspace', agents: { main: { type: 'main' } } }));
      path = join(directory, 'agents', 'main', 'wire.jsonl');
      return { payload: { hook_event_name: name, session_id: id, cwd: '/other/cwd',
        client_type: 'kimi_code_cli', source: 'startup' }, path };
    }
    path = join(root, `${agent} ${id}.jsonl`);
    await write(path, transcript(agent, id));
    return { payload: { hook_event_name: name, session_id: id, transcript_path: path, cwd: root,
      ...(agent === 'claude' ? { source: 'startup', permission_mode: 'default' } : { source: 'startup' }) }, path };
  };
  return { root, env, calls, checks, options, write, event };
}

async function fakeHc(f) {
  const bin = join(f.root, 'bin');
  await mkdir(bin);
  await copyFile(new URL('./fixtures/fake-hc.mjs', import.meta.url), join(bin, 'hc'));
  await chmod(join(bin, 'hc'), 0o755);
  f.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  f.env.FAKE_HC_STATE = join(f.root, 'hc.json');
  await writeFile(f.env.FAKE_HC_STATE, JSON.stringify([{ address: 't1', name: 'terminal', state: 'live', labels: {} }]));
  return async () => JSON.parse(await readFile(f.env.FAKE_HC_STATE, 'utf8'))[0].labels;
}

function launch(env) {
  const child = spawn(process.execPath, ['--use-env-proxy', cli, 'claude'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, closed };
}

test('outside Herdr returns before accessing stdin or validating the payload', async () => {
  const input = { [Symbol.asyncIterator]() { throw new Error('stdin was read'); } };
  assert.equal(await hookMain(['invalid'], {}, input), 'ignored');
  assert.equal(await processHookEvent('invalid', null, { env: {} }), 'ignored');
});

test('CLI outside Herdr exits with its stdin pipe still open', { timeout: 5000 }, async (t) => {
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID;
  const { child, closed } = launch(env);
  t.after(() => child.kill('SIGKILL'));
  assert.deepEqual(await closed, { code: 0, stdout: '', stderr: '' });
});

for (const agent of ['claude', 'codex', 'kimi']) {
  test(`${agent}: actual lifecycle payloads bind before scheduling and scope stop/end by path`, async (t) => {
    const f = await fixture(t);
    const { payload, path } = await f.event(agent);
    await processHookEvent(agent, payload, f.options);
    assert.deepEqual(f.calls, [['bind', 't1', agent, path]]);
    assert.deepEqual(f.checks, [['check', 't1', '--session', path]]);
    await processHookEvent(agent, { ...payload, hook_event_name: 'UserPromptSubmit',
      prompt: agent === 'kimi' ? [{ type: 'text', text: 'Fix login' }] : 'Fix login' }, f.options);
    assert.equal(f.calls.length, 2);
    assert.equal(f.checks.length, 2);
    await processHookEvent(agent, { ...payload, hook_event_name: 'Stop', stop_hook_active: false }, f.options);
    assert.equal(f.calls.length, 2);
    assert.equal(f.checks.length, 3);
    await processHookEvent(agent, { ...payload, hook_event_name: 'SessionEnd', reason: 'exit' }, f.options);
    assert.deepEqual(f.calls.at(-1), ['unbind', 't1', '--session', path]);
    assert.equal(f.checks.length, 3);
  });

  test(`${agent}: old Stop/SessionEnd and queued checks cannot change a newer binding`, async (t) => {
    const f = await fixture(t);
    const getLabels = await fakeHc(f);
    const old = await f.event(agent, 'old');
    const current = await f.event(agent, 'current');
    const run = (args, env) => main(args, env, () => {});
    const options = { ...f.options, run };
    await processHookEvent(agent, old.payload, options);
    await processHookEvent(agent, current.payload, options);
    const labels = await getLabels();
    await processHookEvent(agent, { ...old.payload, hook_event_name: 'Stop' }, options);
    // Run both delayed old checks only after the newer session has bound.
    for (const args of f.checks.filter((args) => args.at(-1) === old.path)) {
      const output = [];
      await main(args, f.env, (value) => output.push(value));
      assert.deepEqual(output, [{ status: 'superseded' }]);
    }
    await processHookEvent(agent, { ...old.payload, hook_event_name: 'SessionEnd' }, options);
    assert.deepEqual(await getLabels(), labels);
    assert.equal(labels['auto-name.session'], current.path);
    await processHookEvent(agent, { ...current.payload, hook_event_name: 'SessionEnd' }, options);
    assert.equal((await getLabels())['auto-name.binding'], undefined);
    await processHookEvent(agent, { ...old.payload, hook_event_name: 'Stop' }, options);
    await run(f.checks.at(-1), f.env);
    assert.equal((await getLabels())['auto-name.binding'], undefined);
  });

  test(`${agent}: ignores child events before session lookup`, async (t) => {
    const f = await fixture(t);
    for (const payload of [
      { hook_event_name: 'SubagentStart' }, { hook_event_name: 'SubagentStop' },
      { hook_event_name: 'Stop', agent_id: 'child' },
      { hook_event_name: 'SessionStart', parent_session_id: 'parent' },
      { hook_event_name: 'UserPromptSubmit', parent_thread_id: 'parent' },
    ]) assert.equal(await processHookEvent(agent, payload, f.options), 'ignored');
    assert.deepEqual([f.calls, f.checks], [[], []]);
  });
}

for (const agent of ['claude', 'codex']) {
  test(`${agent}: accepts exact paths before creation and rejects an actual session mismatch`, async (t) => {
    const f = await fixture(t);
    const path = join(f.root, 'not-yet-created.jsonl');
    const payload = { hook_event_name: 'SessionStart', session_id: 'new', transcript_path: path };
    await processHookEvent(agent, payload, f.options);
    await writeFile(path, '');
    await processHookEvent(agent, payload, f.options);
    await writeFile(path, transcript(agent, 'different'));
    for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      await assert.rejects(processHookEvent(agent, { ...payload, hook_event_name }, f.options), /session_identity_mismatch/);
    }
    assert.equal(f.calls.length, 2);
    assert.equal(f.checks.length, 2);
    await assert.rejects(processHookEvent(agent, { ...payload, transcript_path: 'relative.jsonl' }, f.options), /session_nonlocal_path/);
    await assert.rejects(processHookEvent(agent, { ...payload, transcript_path: undefined }, f.options), /session_nonlocal_path/);
  });
}

test('Claude ignores subagent paths even before creation and sidechain transcript records', async (t) => {
  const f = await fixture(t);
  const { payload } = await f.event('claude');
  assert.equal(await processHookEvent('claude', { ...payload,
    transcript_path: join(f.root, 'session', 'subagents', 'agent-a.jsonl') }, f.options), 'ignored');
  await writeFile(payload.transcript_path, jsonl([{ sessionId: 'session', isSidechain: true,
    type: 'user', message: { role: 'user', content: 'Child request' } }]));
  assert.equal(await processHookEvent('claude', payload, f.options), 'ignored');
  assert.deepEqual(f.calls, []);
});

test('Codex excludes inherited thread mismatch and rollout subagent sources', async (t) => {
  const f = await fixture(t);
  const { payload } = await f.event('codex');
  f.env.CODEX_THREAD_ID = 'parent';
  assert.equal(await processHookEvent('codex', payload, f.options), 'ignored');
  f.env.CODEX_THREAD_ID = 'session';
  await processHookEvent('codex', payload, f.options);
  for (const source of ['subagent', { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }]) {
    await writeFile(payload.transcript_path, jsonl([{ type: 'session_meta', payload: { id: 'session', source } }]));
    assert.equal(await processHookEvent('codex', payload, f.options), 'ignored');
  }
  assert.equal(f.calls.length, 1);
});

test('Codex validates identity in explicitly supplied compressed rollouts', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'rollout.jsonl.zst');
  await writeFile(path, zstdCompressSync(Buffer.from(transcript('codex', 'session'))));
  await processHookEvent('codex', { hook_event_name: 'SessionStart', session_id: 'session', transcript_path: path }, f.options);
  await assert.rejects(processHookEvent('codex', { hook_event_name: 'SessionStart', session_id: 'other', transcript_path: path }, f.options), /session_identity_mismatch/);
  assert.equal(f.calls.length, 1);
});

test('Kimi resolves only the exact ID regardless of cwd, transcript hint, or newer sessions', async (t) => {
  const f = await fixture(t);
  const { payload, path } = await f.event('kimi', 'wanted');
  await f.event('kimi', 'newer');
  await processHookEvent('kimi', { ...payload, agent_id: 'main', transcript_path: '/wrong/context.jsonl' }, f.options);
  assert.deepEqual(f.calls, [['bind', 't1', 'kimi', path]]);
  await assert.rejects(processHookEvent('kimi', { ...payload, session_id: 'want' }, f.options), /session_not_ready/);
  const duplicate = join(f.env.KIMI_CODE_HOME, 'sessions', 'another-workspace', 'wanted', 'state.json');
  await f.write(duplicate, JSON.stringify({ id: 'wanted', version: 2 }));
  await assert.rejects(processHookEvent('kimi', payload, f.options), /session_identity_ambiguous/);
  assert.equal(f.calls.length, 1);
});

test('Kimi rejects mismatched state identity and traversal IDs', async (t) => {
  const f = await fixture(t);
  const { payload, path } = await f.event('kimi');
  await writeFile(join(dirname(dirname(dirname(path))), 'state.json'), JSON.stringify({ id: 'other', version: 2 }));
  await assert.rejects(processHookEvent('kimi', payload, f.options), /session_identity_mismatch/);
  for (const session_id of ['..', '../session', 'a/b', 'a\\b']) {
    await assert.rejects(processHookEvent('kimi', { ...payload, session_id }, f.options), /session_identity_mismatch/);
  }
  assert.deepEqual(f.calls, []);
});

test('bind failure schedules no provider work', async (t) => {
  const f = await fixture(t);
  const { payload } = await f.event('claude');
  await assert.rejects(processHookEvent('claude', payload, { ...f.options,
    run: async () => { throw new Error('target_cli_failed'); } }), /target_cli_failed/);
  assert.deepEqual(f.checks, []);
});

test('CLI returns while its detached provider check is blocked and preserves the environment', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const getLabels = await fakeHc(f);
  const { payload, path } = await f.event('claude');
  let reply, notify;
  const started = new Promise((resolve) => { notify = resolve; });
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    reply = () => response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      decision: 'new_task', summary: 'Fix login', name: 'fix-login',
    }) } }] }));
    response.setHeader('content-type', 'application/json');
    notify();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { reply?.(); server.closeAllConnections(); server.close(resolve); }));
  f.env.DEEPSEEK_API_KEY = 'test-only';
  f.env.NO_PROXY = '127.0.0.1';
  await f.write(join(f.env.OH_MY_HERDR_HOME, 'config.json'), JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  const { child, closed } = launch(f.env);
  t.after(() => child.kill('SIGKILL'));
  child.stdin.end(JSON.stringify(payload));
  await started;
  // A provider response is deliberately withheld until the hook process closes all pipes.
  assert.deepEqual(await closed, { code: 0, stdout: '', stderr: '' });
  reply();
  const store = new Store(join(f.env.OH_MY_HERDR_HOME, 'state'), f.env.HC_SESSION);
  let completed = false;
  for (let i = 0; i < 150; i++) {
    const labels = await getLabels();
    const state = await store.load(JSON.stringify(['claude', path, labels['auto-name.binding']]));
    if (state?.lastApplied === 'fix-login' && (await store.requests()).length === 0) { completed = true; break; }
    await delay(25);
  }
  assert.equal(completed, true);
  assert.equal((await getLabels())['auto-name.task'], 'fix-login');
});

test('check scheduling waits for the exact bind to finish', async (t) => {
  const f = await fixture(t);
  const { payload } = await f.event('claude');
  let release, entered;
  const binding = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const processing = processHookEvent('claude', payload, { ...f.options,
    run: async () => { entered(); await gate; } });
  await binding;
  assert.deepEqual(f.checks, []);
  release();
  await processing;
  assert.equal(f.checks.length, 1);
});
