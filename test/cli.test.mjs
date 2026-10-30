import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, copyFile, chmod, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const jsonl = (records) => records.map(JSON.stringify).join('\n') + '\n';
const session = (id, goal) => jsonl([{ type: 'session', version: 3, id },
  { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: goal } }]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'oh-my-herdr-cli-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(home); await mkdir(bin);
  await copyFile(new URL('./fixtures/fake-hc.mjs', import.meta.url), join(bin, 'hc'));
  await chmod(join(bin, 'hc'), 0o755);
  const state = join(root, 'hc.json');
  const labels = { 'herdr.space': 'space-1', 'herdr.tab': 'tab-1', custom: 'keep=value' };
  await writeFile(state, JSON.stringify([{ address: 't1', name: 'manual-terminal', state: 'live', labels }]));
  const env = { ...process.env, OH_MY_HERDR_HOME: home, HC_SESSION: 'test',
    HC_TERMINAL_ID: 't1', FAKE_HC_STATE: state, DEEPSEEK_API_KEY: 'test-api-key',
    PATH: `${bin}${delimiter}${process.env.PATH}` };
  const f = { root, home, env, state, calls: 0, labels };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    f.calls++;
    f.lastInput = JSON.parse(JSON.parse(body).messages[1].content);
    if (f.beforeReply) await f.beforeReply();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      decision: 'new_task', summary: 'Fix login', name: 'fix-login',
    }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await writeFile(join(home, 'config.json'), JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  f.path = join(root, 'session one.jsonl');
  await writeFile(f.path, session('s1', 'Fix login'));
  f.run = async (...args) => {
    const { stdout } = await execute(process.execPath, [cli, ...args], { env, timeout: 20000 });
    return stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  };
  f.get = async () => JSON.parse(await readFile(state, 'utf8'))[0];
  f.label = (...values) => execute(join(bin, 'hc'), ['label', 't1', ...values], { env });
  return f;
}

test('CLI binds exact paths, preserves labels and caches tool-only updates', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('check'))[0].status, 'unbound');
  assert.equal(f.calls, 0);
  const [binding] = await f.run('bind', 'manual-terminal', 'pi', f.path);
  assert.equal(binding.session, f.path);
  assert.equal((await f.run('bind', 't1', 'pi', f.path))[0].binding, binding.binding);
  assert.equal((await f.run('check')).at(-1).status, 'renamed');
  const terminal = await f.get();
  assert.equal(terminal.name, 'manual-terminal');
  for (const [key, value] of Object.entries(f.labels)) assert.equal(terminal.labels[key], value);
  assert.equal(terminal.labels['auto-name.task'], 'fix-login');
  assert.equal((await f.run('check')).at(-1).status, 'unchanged');
  const text = await readFile(f.path, 'utf8');
  await writeFile(f.path, text + jsonl([{ type: 'message', id: 'tool', parentId: 'u1',
    message: { role: 'toolResult', content: 'tool output' } }]));
  assert.equal((await f.run('check')).at(-1).status, 'unchanged');
  assert.equal(f.calls, 1);
  assert.equal((await f.run('unbind', '--session', '/different'))[0].status, 'superseded');
  assert.equal((await f.run('unbind', '--session', f.path))[0].status, 'unbound');
  assert.equal((await f.get()).labels['auto-name.task'], 'fix-login');
  assert.equal((await f.run('check'))[0].status, 'unbound');
});

test('CLI manual task edits pause; rename is one-off and resume reenables naming', async (t) => {
  const f = await fixture(t);
  await f.run('bind', 't1', 'pi', f.path);
  await f.run('check');
  await f.label('auto-name.task=human-name');
  assert.equal((await f.run('check')).at(-1).status, 'external_name_paused');
  assert.equal((await f.run('check')).at(-1).status, 'paused');
  assert.equal(f.calls, 1);
  assert.equal((await f.run('rename')).at(-1).status, 'renamed');
  assert.equal((await f.run('check')).at(-1).status, 'paused');
  assert.equal((await f.run('resume')).at(-1).status, 'renamed');
  assert.equal((await f.run('check')).at(-1).status, 'unchanged');
  assert.equal(f.calls, 3);
  assert.equal((await f.run('pause')).at(-1).status, 'paused');
});

test('CLI discards in-flight result when binding switches and rejects an old hook path', async (t) => {
  const f = await fixture(t);
  const other = join(f.root, 'other.jsonl');
  await writeFile(other, session('s2', 'Fix payments'));
  await f.run('bind', 't1', 'pi', f.path);
  let notify, release;
  const started = new Promise((resolve) => { notify = resolve; });
  const ready = new Promise((resolve) => { release = resolve; });
  f.beforeReply = () => { notify(); return ready; };
  const checking = f.run('check');
  await started;
  await f.run('bind', 't1', 'pi', other);
  release();
  assert.equal((await checking).at(-1).status, 'superseded');
  assert.equal((await f.get()).labels['auto-name.task'], undefined);
  assert.equal((await f.run('check', '--session', f.path))[0].status, 'superseded');
  assert.equal(f.calls, 1);
  f.beforeReply = null;
  assert.equal((await f.run('check')).at(-1).status, 'renamed');
  assert.equal(f.lastInput.newMessages[0].text, 'Fix payments');
});

test('CLI validates paths and watch interval without touching the provider', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run('bind', 't1', 'pi', 'relative.jsonl'), (error) => {
    assert.match(error.stderr, /session_nonlocal_path/); return true;
  });
  await assert.rejects(f.run('watch', '--interval', '0'), (error) => {
    assert.match(error.stderr, /request_invalid_interval/); return true;
  });
  assert.equal(f.calls, 0);
});


test('watch visits bound live sessions only and stops on SIGTERM', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const terminals = JSON.parse(await readFile(f.state, 'utf8'));
  terminals.push({ address: 't2', name: 'unbound', state: 'live', labels: {} });
  await writeFile(f.state, JSON.stringify(terminals));
  await f.run('bind', 't1', 'pi', f.path);
  const watcher = spawn(process.execPath, [cli, 'watch', '--interval', '5'], {
    env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => watcher.kill('SIGKILL'));
  const exited = new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('exit', (code, signal) => resolve({ code, signal }));
  });
  let output = '';
  await new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('"renamed"')) resolve();
    });
  });
  watcher.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(f.calls, 1);
  assert.equal(output.includes('"terminal":"t2"'), false);
});
