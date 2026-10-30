#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Hc, sessionPath } from './hc.mjs';
import { Store, safeError } from './state.mjs';
import { readSession, supportedAgents } from './session.mjs';
import { classify, loadConfig } from './naming.mjs';
import { processRequest } from './engine.mjs';

export const HELP = `Usage: node src/main.mjs <command>
  bind <terminal> <pi|claude|codex|kimi> <absolute-session-path>
  unbind [terminal] [--session <absolute-session-path>]
  check [terminal] [--session <absolute-session-path>]
  rename [terminal]
  pause [terminal]
  resume [terminal]
  watch [--interval <seconds>]

Terminal defaults to HC_TERMINAL_ID. watch checks bound live terminals only.
Interval defaults to 15 seconds (range: 5-300). Ctrl-C stops watch.
rename generates once while keeping pause; resume enables automatic naming.
Manual changes to auto-name.task pause naming at the next check.
Config: ~/.config/oh-my-herdr/config.json; override root with OH_MY_HERDR_HOME.
Binding labels: auto-name.agent, auto-name.session, auto-name.binding.
Task label: auto-name.task. Other labels and terminal names are preserved.
`;

export async function drain({ hc, store, env, home, output }) {
  const lock = await store.lock();
  const visited = new Set();
  try {
    for (let count = 0; count < 128; count++) {
      lock.assert();
      const requests = await store.requests();
      const next = requests.find((request) => !visited.has(request.id));
      if (!next) break;
      visited.add(next.id);
      if (next.action === 'check' && requests.some((r) => r.id > next.id &&
          r.action === 'check' && r.terminalId === next.terminalId && r.binding === next.binding)) {
        await store.remove(next.id);
        continue;
      }
      try {
        const status = await processRequest(next, {
          hc, store, readSession, assertLock: lock.assert,
          classify: async (input) => classify(input, await loadConfig(home, env)),
        });
        output({ status, terminal: next.terminalId });
        if (status !== 'stale_result') await store.remove(next.id);
      } catch (error) {
        const code = safeError(error);
        if (['target_changed', 'target_unsupported_session', 'request_superseded'].includes(code)) {
          await store.remove(next.id);
          output({ status: 'superseded', terminal: next.terminalId });
        } else {
          output({ status: 'pending', error: code, terminal: next.terminalId });
        }
      }
    }
  } finally { await lock.release(); }
}

function bound(terminal) {
  return terminal.state === 'live' && terminal.binding && supportedAgents.includes(terminal.agent) &&
    typeof sessionPath(terminal) === 'string' && isAbsolute(sessionPath(terminal));
}

async function enqueue(store, terminal, action) {
  await store.enqueue({ action, terminalId: terminal.terminal_id, agent: terminal.agent,
    path: sessionPath(terminal), binding: terminal.binding });
}

export async function main(args = process.argv.slice(2), env = process.env, output = (value) => console.log(JSON.stringify(value))) {
  const [action = 'check', ...rest] = args;
  if (['--help', '-h', 'help'].includes(action)) { console.log(HELP); return; }
  if (!['bind', 'unbind', 'check', 'rename', 'pause', 'resume', 'watch'].includes(action)) throw new Error('request_invalid_command');
  const home = env.OH_MY_HERDR_HOME || join(homedir(), '.config', 'oh-my-herdr');
  const store = new Store(join(home, 'state'), env.HC_SESSION || 'default');
  await store.init();
  const hc = new Hc(env, store);
  const dependencies = { hc, store, home, env, output };
  if (action === 'bind') {
    if (rest.length !== 3) throw new Error('request_invalid_arguments');
    const target = await hc.bind(...rest);
    output({ status: 'bound', terminal: target.terminal_id, agent: target.agent,
      session: sessionPath(target), binding: target.binding });
    return;
  }
  if (action === 'watch') {
    const seconds = rest.length ? Number(rest[1]) : 15;
    if ((rest.length && (rest.length !== 2 || rest[0] !== '--interval')) ||
        !Number.isFinite(seconds) || seconds < 5 || seconds > 300) throw new Error('request_invalid_interval');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      while (!controller.signal.aborted) {
        try {
          for (const terminal of (await hc.list()).filter(bound)) await enqueue(store, terminal, 'check');
          await drain(dependencies);
        } catch (error) { output({ status: 'pending', error: safeError(error) }); }
        await delay(seconds * 1000, undefined, { signal: controller.signal }).catch((error) => {
          if (error.name !== 'AbortError') throw error;
        });
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }
  let target = env.HC_TERMINAL_ID;
  if (rest[0] && !rest[0].startsWith('--')) target = rest.shift();
  let expectedPath;
  if (rest.length === 2 && rest[0] === '--session' && ['check', 'unbind'].includes(action)) expectedPath = rest[1];
  else if (rest.length) throw new Error('request_invalid_arguments');
  if (!target) throw new Error('target_identity_missing');
  if (action === 'unbind') { output({ status: await hc.unbind(target, expectedPath) }); return; }
  const terminal = await hc.get(target);
  if (!bound(terminal)) { output({ status: 'unbound', terminal: terminal.terminal_id }); return; }
  if (expectedPath && expectedPath !== sessionPath(terminal)) { output({ status: 'superseded' }); return; }
  await enqueue(store, terminal, action);
  await drain(dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: safeError(error) }));
    process.exitCode = 1;
  });
}
