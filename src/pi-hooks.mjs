import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./main.mjs', import.meta.url));

export function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--use-env-proxy', cli, ...args], {
      env, timeout: 90000, maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) reject(new Error('request_hook_failed'));
      else resolve(stdout);
    });
  });
}

// Kept separate from the Pi entry point so lifecycle ordering can be tested without Pi.
export function registerPiHooks(pi, run = (args) => runCli(args, env), env = process.env) {
  const terminal = env.HC_TERMINAL_ID;
  if (!terminal) return;
  let session;
  let active = false;
  let generation = 0;
  let running = false;
  let dirty = false;
  let timer;

  function schedule() {
    if (!active || !session) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, 100);
    timer.unref?.();
  }
  async function flush() {
    if (running || !active || !session) return;
    running = true;
    try {
      while (dirty && active) {
        dirty = false;
        const path = session;
        // The CLI captures the binding generation and rechecks it after model latency.
        await run(['check', terminal, '--session', path]).catch(() => {});
      }
    } finally { running = false; }
  }
  pi.on('session_start', async (_event, ctx) => {
    // Headless child sessions inherit HC_TERMINAL_ID but do not own its terminal.
    if (ctx.mode !== 'tui') return;
    const current = ++generation;
    active = false;
    session = ctx.sessionManager.getSessionFile();
    if (!session) return; // --no-session has no transcript to bind.
    try {
      // Binding is short. Model work starts in a separate asynchronous check.
      await run(['bind', terminal, 'pi', session]);
      if (generation !== current) return;
      active = true;
      schedule();
    } catch {
      if (ctx.hasUI) ctx.ui.notify('oh-my-herdr: session binding failed. Run the bind command to retry.', 'warning');
    }
  });
  pi.on('message_end', (event) => {
    const message = event.message;
    if (message?.role === 'user' || (message?.role === 'assistant' &&
        (typeof message.content === 'string' ? message.content.trim() :
          message.content?.some((part) => part.type === 'text' && part.text?.trim())))) schedule();
  });
  for (const event of ['agent_start', 'agent_end', 'agent_settled', 'session_tree']) {
    pi.on(event, schedule);
  }
  pi.on('session_shutdown', async (event) => {
    generation++;
    active = false;
    dirty = false;
    clearTimeout(timer);
    // Invalidate old in-flight work before replacing the session runtime.
    // Reload/quit retain the same binding and its pause/manual-override state.
    if (session && ['new', 'resume', 'fork'].includes(event.reason)) {
      await run(['unbind', terminal, '--session', session]).catch(() => {});
    }
  });
}
