#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from './main.mjs';
import { readSession as readFileSession } from './pi-session.mjs';
import { resolveKimiSessionPath } from './session.mjs';
import { safeError } from './state.mjs';

const cli = fileURLToPath(new URL('./main.mjs', import.meta.url));
const runCommand = (args, env) => main(args, env, () => {});

export function scheduleCheck(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--use-env-proxy', cli, ...args], {
      env, detached: true, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function explicitTranscript(agent, event) {
  const path = event.transcript_path;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('session_nonlocal_path');
  // Claude child transcripts can be announced before their first record is written.
  if (agent === 'claude' && path.split('/').includes('subagents')) return;
  let child = false;
  try {
    await readFileSession(path, (text) => {
      let records;
      try {
        records = text.slice(0, text.lastIndexOf('\n') + 1).split('\n')
          .filter((line) => line.trim()).map(JSON.parse);
      } catch { throw new Error('session_invalid_json'); }
      for (const record of records) {
        const id = agent === 'claude' ? record.sessionId :
          record.type === 'session_meta' ? record.payload?.id : undefined;
        if (id !== undefined && id !== event.session_id) throw new Error('session_identity_mismatch');
      }
      if (agent === 'claude') {
        child = records.find((record) => record.sessionId)?.isSidechain === true;
      } else {
        const source = records.find((record) => record.type === 'session_meta')?.payload?.source;
        child = source === 'subagent' || (source != null && typeof source === 'object' && 'subagent' in source);
      }
      return {};
    });
  } catch (error) {
    // SessionStart precedes transcript creation. The explicit hook path is still authoritative.
    if (error.code !== 'ENOENT') throw error;
  }
  return child ? undefined : path;
}

// run performs only short bind/unbind commands; schedule launches a separate check worker.
export async function processHookEvent(agent, event, {
  env = process.env, run = runCommand, schedule = scheduleCheck,
} = {}) {
  const terminal = env.HC_TERMINAL_ID;
  if (!terminal) return 'ignored';
  if (!['claude', 'codex', 'kimi'].includes(agent)) throw new Error('target_unsupported_session');
  const name = event?.hook_event_name;
  if (!['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(name)) return 'ignored';
  if (event.agent_id && (agent !== 'kimi' || event.agent_id !== 'main')) return 'ignored';
  if (event.isSidechain || event.parent_session_id || event.parent_thread_id) return 'ignored';
  if (typeof event.session_id !== 'string' || !event.session_id) throw new Error('target_identity_missing');
  // A Codex started by a parent thread inherits its terminal and CODEX_THREAD_ID.
  if (agent === 'codex' && env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== event.session_id) return 'ignored';
  const path = agent === 'kimi' ? await resolveKimiSessionPath(event.session_id, env) :
    await explicitTranscript(agent, event);
  if (!path) return 'ignored';
  if (name === 'SessionEnd') {
    await run(['unbind', terminal, '--session', path], env);
    return 'unbound';
  }
  if (name === 'SessionStart' || name === 'UserPromptSubmit') {
    await run(['bind', terminal, agent, path], env);
  }
  await schedule(['check', terminal, '--session', path], env);
  return 'scheduled';
}

export async function hookMain(args = process.argv.slice(2), env = process.env, input = process.stdin) {
  // Do not touch stdin outside Herdr: it may be an interactive terminal or an open pipe.
  if (!env.HC_TERMINAL_ID) return 'ignored';
  if (args.length !== 1 || !['claude', 'codex', 'kimi'].includes(args[0])) {
    throw new Error('request_invalid_arguments');
  }
  let text = '';
  for await (const chunk of input) text += chunk;
  let event;
  try { event = JSON.parse(text); }
  catch { throw new Error('request_invalid_json'); }
  return processHookEvent(args[0], event, { env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  hookMain().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: safeError(error) }));
    process.exitCode = 1;
  });
}
