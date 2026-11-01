import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'oh-my-herdr-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo with spaces');
  const bin = join(dir, 'bin');
  for (const path of [join(repo, 'scripts'), join(repo, 'src'), bin]) await mkdir(path, { recursive: true });
  for (const path of ['install.sh', 'scripts/setup.mjs', 'src/naming.mjs', 'config.example.json']) {
    await copyFile(new URL(`../${path}`, import.meta.url), join(repo, path));
  }
  await writeFile(join(repo, 'scripts/install.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.SETUP_LOG, 'install\\n');
    process.exit(Number(process.env.INSTALL_EXIT || 0));
  `);
  for (const [name, body] of Object.entries({
    npm: 'printf "npm:%s:%s\\n" "$*" "$PWD" >> "$SETUP_LOG"; exit "${NPM_EXIT:-0}"',
    'herdr-app': 'exit "${HERDR_EXIT:-0}"',
    hc: 'exit 0',
  })) await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OH_MY_HERDR_HOME: join(dir, 'config'),
    SETUP_LOG: join(dir, 'log'), DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', TYPESAFE_API_KEY: '' };
  return {
    repo, env,
    run: overrides => spawnSync('bash', [join(repo, 'install.sh')], {
      cwd: tmpdir(), env: { ...env, ...overrides }, encoding: 'utf8',
    }),
  };
}

test('one-command setup works outside the repo, creates config, and preserves it on rerun', async t => {
  const f = await fixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Naming is not ready/);
  const configPath = join(f.env.OH_MY_HERDR_HOME, 'config.json');
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), JSON.parse(await readFile(join(f.repo, 'config.example.json'), 'utf8')));
  const config = '{"provider":"openai","model":"my-model"}\n';
  await writeFile(configPath, config);
  const second = f.run({ OPENAI_API_KEY: 'test-key' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /credentials are ready/);
  assert.equal(await readFile(configPath, 'utf8'), config);
  assert.equal(await readFile(f.env.SETUP_LOG, 'utf8'),
    `npm:ci --no-audit --no-fund:${f.repo}\ninstall\nnpm:ci --no-audit --no-fund:${f.repo}\ninstall\n`);
});

test('setup stops before dependency installation when Herdr is unavailable', async t => {
  const f = await fixture(t);
  const result = f.run({ HERDR_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Start Herdr App/);
  await assert.rejects(readFile(f.env.SETUP_LOG), { code: 'ENOENT' });
});

test('setup stops on dependency failure and propagates installer failures', async t => {
  const f = await fixture(t);
  const dependencyFailure = f.run({ NPM_EXIT: '7' });
  assert.equal(dependencyFailure.status, 7);
  assert.doesNotMatch(await readFile(f.env.SETUP_LOG, 'utf8'), /\ninstall\n/);
  const installerFailure = f.run({ INSTALL_EXIT: '3' });
  assert.equal(installerFailure.status, 3);
  assert.match(installerFailure.stderr, /Installation needs attention/);
  assert.doesNotMatch(installerFailure.stdout, /Setup finished/);
});
