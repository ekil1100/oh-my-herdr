import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { installIntegrations, uninstallIntegrations } from '../src/integration-install.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const MANIFEST = 'integration-installation.json';
const digest = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const write = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : encode(value));
};
const outcome = (results, agent) => results.find(result => result.agent === agent);

async function fixture(t, agents = ['pi', 'claude', 'codex', 'kimi']) {
  const base = await mkdtemp(join(tmpdir(), "integration ' $dollar `tick` "));
  t.after(() => rm(base, { recursive: true, force: true }));
  const options = { root: join(base, "repo ' # name"), home: join(base, "user's home"),
    configHome: join(base, "config ' $HOME `command`"), env: { PATH: '' } };
  const paths = {
    pi: join(options.home, '.pi/agent/extensions/oh-my-herdr.js'),
    settings: join(options.home, '.pi/agent/settings.json'),
    claude: join(options.home, '.claude/settings.json'),
    codex: join(options.home, '.codex/hooks.json'),
    codexConfig: join(options.home, '.codex/config.toml'),
    kimi: join(options.home, '.kimi-code/config.toml'),
    manifest: join(options.configHome, MANIFEST),
  };
  await mkdir(options.root, { recursive: true });
  await mkdir(options.home, { recursive: true });
  for (const agent of agents) await mkdir(dirname(agent === 'pi' ? paths.settings : paths[agent]), { recursive: true });
  if (agents.includes('codex')) await write(paths.codexConfig, '# Preserve this flag\n[features]\nhooks = true\n');
  return { base, options, paths, install: () => installIntegrations(options), uninstall: () => uninstallIntegrations(options) };
}

function assertInstalled(results, agents = ['pi', 'claude', 'codex', 'kimi']) {
  for (const agent of agents) assert.equal(outcome(results, agent).status, 'installed', JSON.stringify(results));
}

async function assertMissing(path) {
  await assert.rejects(readFile(path), { code: 'ENOENT' });
}

test('install/uninstall preserves other settings, hooks, TOML comments and UI manifest', async t => {
  const f = await fixture(t);
  const userHook = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user', timeout: 42 }] };
  const claude = { model: 'unchanged', env: { TOKEN: 'never-copy-this-secret' }, hooks: { SessionStart: [userHook], Stop: [] } };
  const codex = { custom: { arbitrary: true }, hooks: { UserPromptSubmit: [userHook] } };
  const kimi = '# Keep comments and whitespace\r\nmodel = "user-model"\r\n\r\n[[hooks]]\r\nevent = "Stop"\r\ncommand = "echo user"';
  await write(f.paths.claude, claude);
  await write(f.paths.codex, codex);
  await write(f.paths.kimi, kimi);
  const ui = join(f.options.configHome, 'installation.json');
  await write(ui, { previousLayout: 'original' });
  assertInstalled(await f.install());
  for (const agent of ['claude', 'codex']) {
    const data = await readJSON(f.paths[agent]);
    for (const event of EVENTS) assert.equal(data.hooks[event].filter(group => group.hooks[0].command.includes('agent-hook.mjs')).length, 1);
  }
  const manifest = await readFile(f.paths.manifest, 'utf8');
  assert.ok(!manifest.includes(claude.env.TOKEN));
  assert.ok(!manifest.includes('echo user'));
  const files = await Promise.all(Object.values(f.paths).map(path => readFile(path, 'utf8').catch(() => null)));
  const second = await f.install();
  assertInstalled(second);
  assert.ok(second.every(result => result.changed === false));
  assert.deepEqual(await Promise.all(Object.values(f.paths).map(path => readFile(path, 'utf8').catch(() => null))), files);
  assert.ok((await f.uninstall()).every(result => result.status === 'uninstalled'));
  assert.deepEqual(await readJSON(f.paths.claude), claude);
  assert.deepEqual(await readJSON(f.paths.codex), codex);
  assert.equal(await readFile(f.paths.kimi, 'utf8'), kimi);
  assert.deepEqual(await readJSON(ui), { previousLayout: 'original' });
  await assertMissing(f.paths.pi);
  assert.ok((await f.uninstall()).every(result => result.status === 'skipped'));
  assertInstalled(await f.install());
});

test('new hook files are removed on uninstall; preexisting empty containers survive', async t => {
  const f = await fixture(t);
  await write(f.paths.claude, { hooks: { Stop: [] } });
  assertInstalled(await f.install());
  await f.uninstall();
  assert.deepEqual(await readJSON(f.paths.claude), { hooks: { Stop: [] } });
  await assertMissing(f.paths.codex);
  await assertMissing(f.paths.kimi);
  await assertMissing(f.paths.pi);
});

test('discovery uses config directories or executable PATH, honors custom homes, and never runs agents', async t => {
  const f = await fixture(t, []);
  assert.ok((await f.install()).every(result => result.code === 'not_installed'));
  const bin = join(f.base, 'bin');
  await write(join(bin, 'claude'), '#!/bin/sh\nexit 99\n');
  await chmod(join(bin, 'claude'), 0o700);
  await write(join(bin, 'kimi'), '#!/bin/sh\nexit 99\n');
  await chmod(join(bin, 'kimi'), 0o600);
  const custom = join(f.base, 'custom claude');
  f.options.env = { PATH: bin, CLAUDE_CONFIG_DIR: custom, CODEX_HOME: join(f.base, 'custom codex'), KIMI_CODE_HOME: join(f.base, 'custom kimi') };
  await write(join(f.options.env.CODEX_HOME, 'config.toml'), 'features.hooks = true\n');
  await mkdir(f.options.env.KIMI_CODE_HOME);
  const results = await f.install();
  assertInstalled(results, ['claude', 'codex', 'kimi']);
  assert.equal(outcome(results, 'pi').code, 'not_installed');
  assert.ok((await readJSON(join(custom, 'settings.json'))).hooks.Stop);
  await assertMissing(f.paths.claude);
  f.options.env = { PATH: '' };
  assert.equal(outcome(await f.uninstall(), 'claude').status, 'uninstalled');
  await assertMissing(join(custom, 'settings.json'));
});

test('non-executable files and directories in PATH do not discover agents', async t => {
  const f = await fixture(t, []);
  const bin = join(f.base, 'bin');
  await write(join(bin, 'claude'), 'not executable');
  await chmod(join(bin, 'claude'), 0o600);
  await mkdir(join(bin, 'codex'));
  f.options.env.PATH = bin;
  assert.ok((await f.install()).every(result => result.code === 'not_installed'));
});

test('generated commands preserve quoted paths, stdin payload and runtime environment', async t => {
  const f = await fixture(t, ['claude']);
  await write(join(f.options.root, 'src/agent-hook.mjs'), `import { readFileSync } from 'node:fs';
console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.OH_MY_HERDR_HOME,
  terminal: process.env.HC_TERMINAL_ID, payload: JSON.parse(readFileSync(0, 'utf8')) }));\n`);
  assertInstalled(await f.install(), ['claude']);
  const command = (await readJSON(f.paths.claude)).hooks.SessionStart[0].hooks[0].command;
  const payload = { hook_event_name: 'SessionStart', session_id: "session ' one", transcript_path: "/path ' with spaces.jsonl" };
  const result = JSON.parse(execFileSync('/bin/sh', ['-c', command], {
    encoding: 'utf8', input: JSON.stringify(payload), env: { ...process.env, HC_TERMINAL_ID: 't123', OH_MY_HERDR_HOME: '/wrong' },
  }));
  assert.deepEqual(result, { args: ['claude'], home: f.options.configHome, terminal: 't123', payload });
});

test('Pi wrapper imports a file URL and supplies runtime env plus pinned config home', async t => {
  const f = await fixture(t, ['pi']);
  await write(join(f.options.root, 'package.json'), { type: 'module' });
  await write(join(f.options.root, 'integrations/pi.js'), 'export default (pi, env) => ({ pi, env });\n');
  assertInstalled(await f.install(), ['pi']);
  const loaded = await import(pathToFileURL(f.paths.pi).href);
  const value = loaded.default('fake-pi');
  assert.equal(value.pi, 'fake-pi');
  assert.deepEqual(value.env, { ...process.env, OH_MY_HERDR_HOME: f.options.configHome });
});

test('Pi migration removes all local package identities while preserving unrelated sources and settings', async t => {
  const f = await fixture(t, ['pi']);
  const alias = join(f.base, 'repo alias');
  await symlink(f.options.root, alias);
  const localAlias = join(dirname(f.paths.settings), 'local-package');
  await symlink(f.options.root, localAlias);
  const other = { source: 'npm:another-package', extensions: ['*.js'], arbitrary: { flag: true } };
  await write(f.paths.settings, {
    theme: 'user-theme', extensions: ['/some/other-extension.js'], packages: [
      f.options.root, { source: relative(dirname(f.paths.settings), f.options.root), extensions: ['integrations/pi.js'] },
      pathToFileURL(f.options.root).href, alias, 'local-package', other, 'git:example.org/tool',
    ],
  });
  assertInstalled(await f.install(), ['pi']);
  assert.deepEqual(await readJSON(f.paths.settings), {
    theme: 'user-theme', extensions: ['/some/other-extension.js'], packages: [other, 'git:example.org/tool'],
  });
  await f.uninstall();
  assert.deepEqual((await readJSON(f.paths.settings)).packages, [other, 'git:example.org/tool']);
});

test('unmanaged Pi wrapper blocks migration and leaves the file untouched, even if content matches', async t => {
  const f = await fixture(t, ['pi']);
  await f.install();
  const content = await readFile(f.paths.pi, 'utf8');
  await rm(f.paths.manifest);
  await write(f.paths.settings, { packages: [f.options.root] });
  const result = outcome(await f.install(), 'pi');
  assert.equal(result.code, 'unmanaged_wrapper');
  assert.equal(await readFile(f.paths.pi, 'utf8'), content);
  assert.deepEqual((await readJSON(f.paths.settings)).packages, [f.options.root]);
  assert.equal(outcome(await f.uninstall(), 'pi').status, 'skipped');
});

test('user-modified managed wrapper, hook and TOML block are refused on install and uninstall', async t => {
  const f = await fixture(t);
  await f.install();
  await write(f.paths.pi, (await readFile(f.paths.pi, 'utf8')) + '// user edit\n');
  const claude = await readJSON(f.paths.claude);
  claude.hooks.Stop[0].hooks[0].timeout = 7;
  await write(f.paths.claude, claude);
  const codex = await readJSON(f.paths.codex);
  codex.hooks.SessionStart[0].hooks[0].command += ' --custom';
  await write(f.paths.codex, codex);
  await write(f.paths.kimi, (await readFile(f.paths.kimi, 'utf8')).replace('event = "Stop"', 'event = "Interrupt"'));
  const contents = await Promise.all(['pi', 'claude', 'codex', 'kimi'].map(agent => readFile(f.paths[agent], 'utf8')));
  for (const run of [f.install, f.uninstall]) {
    const results = await run();
    for (const result of results) assert.equal(result.code, 'managed_content_changed', JSON.stringify(results));
    assert.deepEqual(await Promise.all(['pi', 'claude', 'codex', 'kimi'].map(agent => readFile(f.paths[agent], 'utf8'))), contents);
  }
});

test('new user hooks and settings, including additions to an owned JSON group, survive removal', async t => {
  const f = await fixture(t, ['claude', 'kimi']);
  await f.install();
  const data = await readJSON(f.paths.claude);
  const extra = { type: 'command', command: 'echo new user hook', arbitrary: true };
  data.hooks.Stop[0].hooks.push(extra);
  data.hooks.Stop.push({ matcher: 'custom', hooks: [extra] });
  data.hooks.NewEvent = [{ hooks: [extra] }];
  data.userSetting = 'new';
  await write(f.paths.claude, data);
  await write(f.paths.kimi, '# User prefix\n' + await readFile(f.paths.kimi, 'utf8') + '\n# User suffix\n[[hooks]]\nevent = "Stop"\ncommand = "echo extra"\n');
  const before = await readFile(f.paths.claude, 'utf8');
  assertInstalled(await f.install(), ['claude', 'kimi']);
  assert.equal(await readFile(f.paths.claude, 'utf8'), before);
  const removed = await f.uninstall();
  assert.equal(outcome(removed, 'claude').status, 'uninstalled');
  assert.equal(outcome(removed, 'kimi').status, 'uninstalled');
  assert.deepEqual(await readJSON(f.paths.claude), { userSetting: 'new', hooks: {
    Stop: [{ hooks: [extra] }, { matcher: 'custom', hooks: [extra] }], NewEvent: [{ hooks: [extra] }],
  } });
  assert.equal(await readFile(f.paths.kimi, 'utf8'), '# User prefix\n\n# User suffix\n[[hooks]]\nevent = "Stop"\ncommand = "echo extra"\n');
});

test('keys or subtables added to the last managed TOML hook are not silently reassigned', async t => {
  for (const suffix of ['timeout = 123\n', '[hooks.extra]\nvalue = 1\n', '[[hooks.extra]]\nvalue = 1\n']) {
    const f = await fixture(t, ['kimi']);
    await f.install();
    const text = await readFile(f.paths.kimi, 'utf8') + suffix;
    await write(f.paths.kimi, text);
    assert.equal(outcome(await f.uninstall(), 'kimi').code, 'managed_content_changed');
    assert.equal(await readFile(f.paths.kimi, 'utf8'), text);
  }
});

test('Kimi rejects incompatible hooks layouts and unfinished strings without altering config', async t => {
  for (const [text, code] of [
    ['hooks = []\n', 'unsupported_hooks_layout'],
    ['[hooks]\n', 'unsupported_hooks_layout'],
    ['[hooks.extra]\nvalue = 1\n', 'unsupported_hooks_layout'],
    ['model = "unfinished', 'invalid_toml'],
    ['model = """unfinished', 'invalid_toml'],
    ['# BEGIN oh-my-herdr managed hooks\n', 'unmanaged_hooks'],
  ]) {
    const f = await fixture(t, ['kimi']);
    await write(f.paths.kimi, text);
    assert.equal(outcome(await f.install(), 'kimi').code, code);
    assert.equal(await readFile(f.paths.kimi, 'utf8'), text);
  }
  const f = await fixture(t, ['kimi']);
  const text = `example = '''\nhooks = []\n'''\n[unrelated]\nhooks = []\n`;
  await write(f.paths.kimi, text);
  assertInstalled(await f.install(), ['kimi']);
  assert.equal(outcome(await f.uninstall(), 'kimi').status, 'uninstalled');
  assert.equal(await readFile(f.paths.kimi, 'utf8'), text);
});

test('Codex missing/false hooks feature is explicit and does not write inert hooks', async t => {
  for (const [config, code] of [
    ['', 'codex_hooks_not_enabled'], ['[features]\nhooks = false\n', 'codex_hooks_disabled'],
    ['note = """\n[features]\nhooks = true\n"""\n', 'codex_hooks_not_enabled'],
    ['[other.features]\nhooks = true\n', 'codex_hooks_not_enabled'],
  ]) {
    const f = await fixture(t, ['codex']);
    await write(f.paths.codexConfig, config);
    const result = outcome(await f.install(), 'codex');
    assert.equal(result.code, code);
    assert.match(result.message, /\[features\]/);
    await assertMissing(f.paths.codex);
    assert.equal(await readFile(f.paths.codexConfig, 'utf8'), config);
  }
  const f = await fixture(t, ['codex']);
  await write(f.paths.codexConfig, '["features"] # comment\n"hooks" = true # enabled\n');
  assertInstalled(await f.install(), ['codex']);
  await write(f.paths.codexConfig, '[features]\nhooks = false\n');
  assert.equal(outcome(await f.uninstall(), 'codex').status, 'uninstalled');
});

test('disableAllHooks and invalid JSON return safe errors, while other agents install', async t => {
  const f = await fixture(t);
  await write(f.paths.claude, { disableAllHooks: true, private: 'private-value' });
  await write(f.paths.codex, '{SECRET_INVALID_JSON');
  const results = await f.install();
  assert.equal(outcome(results, 'claude').code, 'hooks_disabled');
  assert.equal(outcome(results, 'codex').code, 'invalid_json');
  assertInstalled(results, ['pi', 'kimi']);
  assert.ok(!JSON.stringify(results).includes('SECRET_INVALID_JSON'));
  assert.ok(!(await readFile(f.paths.manifest, 'utf8')).includes('private-value'));
});

test('symlink files and wrappers are refused; symlink directories are pinned against retargeting', async t => {
  const f = await fixture(t, ['pi', 'claude']);
  const target = join(f.base, 'outside');
  await write(target, '{}\n');
  await mkdir(dirname(f.paths.pi), { recursive: true });
  await symlink(target, f.paths.pi);
  await symlink(target, f.paths.claude);
  const results = await f.install();
  assert.equal(outcome(results, 'pi').code, 'unsafe_file');
  assert.equal(outcome(results, 'claude').code, 'unsafe_file');
  assert.equal(await readFile(target, 'utf8'), '{}\n');
  await rm(dirname(f.paths.claude), { recursive: true });
  const first = join(f.base, 'first'), second = join(f.base, 'second');
  await mkdir(first); await mkdir(second);
  await symlink(first, dirname(f.paths.claude));
  assertInstalled(await f.install(), ['claude']);
  await rm(dirname(f.paths.claude));
  await symlink(second, dirname(f.paths.claude));
  assert.equal(outcome(await f.uninstall(), 'claude').code, 'path_changed');
  assert.ok((await readJSON(join(first, 'settings.json'))).hooks.Stop);
  await assertMissing(join(second, 'settings.json'));
});

test('symlink manifests and config homes are refused without touching their targets', async t => {
  const f = await fixture(t, ['claude']);
  const target = join(f.base, 'manifest-target');
  await write(target, '{"private":"untouched"}\n');
  await mkdir(f.options.configHome);
  await symlink(target, f.paths.manifest);
  assert.ok((await f.install()).every(result => result.code === 'unsafe_file'));
  assert.equal(await readFile(target, 'utf8'), '{"private":"untouched"}\n');
  await rm(f.options.configHome, { recursive: true });
  const folder = join(f.base, 'another-config'); await mkdir(folder);
  await symlink(folder, f.options.configHome);
  assert.ok((await f.install()).every(result => result.code === 'unsafe_file'));
});

test('changing config directory requires uninstall; changing repo updates only owned content', async t => {
  const f = await fixture(t, ['pi', 'claude', 'kimi']);
  await f.install();
  const secondRoot = join(f.base, 'second repo'); await mkdir(secondRoot);
  f.options.root = secondRoot;
  assertInstalled(await f.install(), ['pi', 'claude', 'kimi']);
  assert.ok((await readFile(f.paths.pi, 'utf8')).includes(pathToFileURL(join(secondRoot, 'integrations/pi.js')).href));
  assert.ok((await readJSON(f.paths.claude)).hooks.Stop[0].hooks[0].command.includes('second repo'));
  f.options.env.CLAUDE_CONFIG_DIR = join(f.base, 'another claude');
  assert.equal(outcome(await f.install(), 'claude').code, 'config_path_changed');
  assert.equal(outcome(await f.uninstall(), 'claude').status, 'uninstalled');
});

test('pending ownership recovers both sides of an interrupted write, and uninstall cancels an unapplied install', async t => {
  for (const applied of [true, false]) {
    for (const uninstall of [true, false]) {
      const f = await fixture(t, ['claude']);
      await f.install();
      const content = await readFile(f.paths.claude, 'utf8');
      const manifest = await readJSON(f.paths.manifest);
      const owner = manifest.agents.claude.resources[0];
      manifest.agents.claude = { resources: [], pending: {
        path: owner.path, physical: owner.physical, beforeHash: null, afterHash: digest(content), owner,
      } };
      await write(f.paths.manifest, manifest);
      if (!applied) await rm(f.paths.claude);
      const result = outcome(await (uninstall ? f.uninstall() : f.install()), 'claude');
      assert.equal(result.status, uninstall ? (applied ? 'uninstalled' : 'skipped') : 'installed', JSON.stringify(result));
      assert.equal((await readJSON(f.paths.manifest)).agents.claude.pending, undefined);
      if (uninstall) await assertMissing(f.paths.claude);
      else assert.equal((await readJSON(f.paths.claude)).hooks.Stop.length, 1);
    }
  }
});

test('pending write with subsequent managed-content edits fails safely and retains the journal', async t => {
  const f = await fixture(t, ['claude']);
  await f.install();
  const content = await readFile(f.paths.claude, 'utf8');
  const manifest = await readJSON(f.paths.manifest);
  const owner = manifest.agents.claude.resources[0];
  manifest.agents.claude = { resources: [], pending: {
    path: owner.path, physical: owner.physical, beforeHash: null, afterHash: digest(content), owner,
  } };
  await write(f.paths.manifest, manifest);
  const data = await readJSON(f.paths.claude);
  data.user = 'edited';
  data.hooks.Stop[0].hooks[0].command += ' --user-edit';
  await write(f.paths.claude, data);
  assert.equal(outcome(await f.install(), 'claude').code, 'pending_content_changed');
  assert.equal(outcome(await f.uninstall(), 'claude').code, 'pending_content_changed');
  assert.deepEqual(await readJSON(f.paths.claude), data);
  assert.ok((await readJSON(f.paths.manifest)).agents.claude.pending);
});

test('a real failed manifest commit leaves recoverable ownership after writing the wrapper', async t => {
  const f = await fixture(t, ['pi']);
  await write(f.paths.settings, { packages: [f.options.root], user: 'keep' });
  const moduleURL = new URL('../src/integration-install.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const options = JSON.parse(process.argv[1]);
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to.endsWith(${JSON.stringify(MANIFEST)})) throw Object.assign(new Error('injected'), {code: 'EIO'});
  return rename(from, to);
};
syncBuiltinESMExports();
const { installIntegrations } = await import(${JSON.stringify(moduleURL)});
console.log(JSON.stringify(await installIntegrations(options)));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.options)], { encoding: 'utf8' }));
  assert.equal(outcome(result, 'pi').code, 'EIO');
  assert.equal(outcome(result, 'pi').partial, true);
  assert.ok((await readJSON(f.paths.manifest)).agents.pi.pending);
  assert.deepEqual((await readJSON(f.paths.settings)).packages, [f.options.root]);
  assertInstalled(await f.install(), ['pi']);
  assert.deepEqual(await readJSON(f.paths.settings), { packages: [], user: 'keep' });
  assert.equal(outcome(await f.uninstall(), 'pi').status, 'uninstalled');
  assert.ok(!(await readdir(dirname(f.paths.pi))).some(name => name.endsWith('.tmp')));
});

test('installed file modes stay private and existing modes are retained', async t => {
  const f = await fixture(t, ['claude', 'kimi']);
  await write(f.paths.claude, {}); await chmod(f.paths.claude, 0o640);
  await f.install();
  assert.equal((await stat(f.paths.claude)).mode & 0o777, 0o640);
  assert.equal((await stat(f.paths.kimi)).mode & 0o777, 0o600);
  assert.equal((await stat(f.paths.manifest)).mode & 0o777, 0o600);
});

test('failed Pi migration keeps wrapper ownership and retries without duplicating the extension', async t => {
  const f = await fixture(t, ['pi']);
  await write(f.paths.settings, { packages: [f.options.root], user: 'keep' });
  const moduleURL = new URL('../src/integration-install.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const options = JSON.parse(process.argv[1]);
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to.endsWith('/settings.json')) throw Object.assign(new Error('injected'), {code: 'EIO'});
  return rename(from, to);
};
syncBuiltinESMExports();
const { installIntegrations } = await import(${JSON.stringify(moduleURL)});
console.log(JSON.stringify(await installIntegrations(options)));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.options)], { encoding: 'utf8' }));
  assert.equal(outcome(result, 'pi').code, 'EIO');
  const record = (await readJSON(f.paths.manifest)).agents.pi;
  assert.equal(record.resources.length, 1);
  assert.equal(record.pending.path, f.paths.settings);
  assert.deepEqual((await readJSON(f.paths.settings)).packages, [f.options.root]);
  assertInstalled(await f.install(), ['pi']);
  assert.deepEqual(await readJSON(f.paths.settings), { packages: [], user: 'keep' });
  assert.equal((await readJSON(f.paths.manifest)).agents.pi.resources.length, 1);
});

test('an interrupted uninstall is finalized without removing user config', async t => {
  const f = await fixture(t, ['claude']);
  await write(f.paths.claude, { user: 'keep' });
  await f.install();
  const before = await readFile(f.paths.claude, 'utf8');
  const after = encode({ user: 'keep' });
  const manifest = await readJSON(f.paths.manifest);
  const owner = manifest.agents.claude.resources[0];
  manifest.agents.claude.pending = { path: owner.path, physical: owner.physical,
    beforeHash: digest(before), afterHash: digest(after), owner: null };
  await write(f.paths.manifest, manifest);
  await write(f.paths.claude, after);
  assert.equal(outcome(await f.uninstall(), 'claude').status, 'skipped');
  assert.deepEqual(await readJSON(f.paths.claude), { user: 'keep' });
  assert.deepEqual((await readJSON(f.paths.manifest)).agents.claude, { resources: [] });
});

test('pending install recovers ownership while preserving unrelated user edits made after the write', async t => {
  for (const agent of ['claude', 'kimi']) {
    const f = await fixture(t, [agent]);
    await f.install();
    const content = await readFile(f.paths[agent], 'utf8');
    const manifest = await readJSON(f.paths.manifest);
    const owner = manifest.agents[agent].resources[0];
    manifest.agents[agent] = { resources: [], pending: {
      path: owner.path, physical: owner.physical, beforeHash: null, afterHash: digest(content), owner,
    } };
    await write(f.paths.manifest, manifest);
    let edited;
    if (agent === 'claude') {
      const data = await readJSON(f.paths.claude); data.user = 'new setting'; edited = encode(data);
    } else edited = '# New user comment\n' + content;
    await write(f.paths[agent], edited);
    assertInstalled(await f.install(), [agent]);
    assert.equal(await readFile(f.paths[agent], 'utf8'), edited);
    assert.equal((await readJSON(f.paths.manifest)).agents[agent].pending, undefined);
    assert.equal(outcome(await f.uninstall(), agent).status, 'uninstalled');
    if (agent === 'claude') assert.deepEqual(await readJSON(f.paths.claude), { user: 'new setting' });
    else assert.equal(await readFile(f.paths.kimi, 'utf8'), '# New user comment\n');
  }
});

test('pending update retries from the old ownership while retaining later user edits', async t => {
  const f = await fixture(t, ['claude']);
  await f.install();
  const oldContent = await readFile(f.paths.claude, 'utf8');
  const oldManifest = await readJSON(f.paths.manifest);
  const oldOwner = oldManifest.agents.claude.resources[0];
  f.options.root = join(f.base, 'replacement root'); await mkdir(f.options.root);
  await f.install();
  const newContent = await readFile(f.paths.claude, 'utf8');
  const newOwner = (await readJSON(f.paths.manifest)).agents.claude.resources[0];
  oldManifest.agents.claude.pending = { path: oldOwner.path, physical: oldOwner.physical,
    beforeHash: digest(oldContent), afterHash: digest(newContent), owner: newOwner };
  await write(f.paths.manifest, oldManifest);
  const edited = JSON.parse(oldContent); edited.user = 'keep'; await write(f.paths.claude, edited);
  assertInstalled(await f.install(), ['claude']);
  const updated = await readJSON(f.paths.claude);
  assert.equal(updated.user, 'keep');
  assert.equal(updated.hooks.Stop[0].hooks[0].command, newOwner.command);
  assert.equal(updated.hooks.Stop.length, 1);
  assert.equal((await readJSON(f.paths.manifest)).agents.claude.pending, undefined);
});
