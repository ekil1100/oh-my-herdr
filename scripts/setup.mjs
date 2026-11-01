import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/naming.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configHome = process.env.OH_MY_HERDR_HOME || resolve(homedir(), '.config/oh-my-herdr');

async function main() {
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const configPath = resolve(configHome, 'config.json');
  const template = await readFile(resolve(root, 'config.example.json'), 'utf8');
  try {
    await writeFile(configPath, template, { flag: 'wx', mode: 0o600 });
    console.log(`Created naming configuration: ${configPath}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Keeping existing naming configuration: ${configPath}`);
  }

  console.log('Installing the interface and agent integrations...');
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/install.mjs')], {
    cwd: root, stdio: 'inherit', env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const retry = process.platform === 'win32' ? '.\\install.ps1' : './install.sh';
    console.error(`Installation needs attention. Resolve the reported errors, then rerun ${retry}.`);
    process.exitCode = result.status || 1;
    return;
  }

  try {
    await loadConfig(configHome);
    console.log('Naming configuration and credentials are ready in this environment.');
  } catch (error) {
    console.log(`Naming is not ready: ${error.message}.`);
    console.log(`Review ${configPath} and set the provider API key in the environment that launches your agents.`);
    console.log('The default configuration uses DEEPSEEK_API_KEY. OpenAI uses OPENAI_API_KEY; the optional classifier uses TYPESAFE_API_KEY.');
  }
  console.log('Setup finished. Run /reload in existing Pi sessions and restart other existing agents.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
