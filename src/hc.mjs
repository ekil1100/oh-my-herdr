import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { supportedAgents } from './session.mjs';

const execute = promisify(execFile);
export const LABELS = {
  task: 'auto-name.task', agent: 'auto-name.agent',
  session: 'auto-name.session', binding: 'auto-name.binding',
};

export function sessionPath(terminal) {
  return terminal.agent_session?.value;
}

function normalize(terminal) {
  const labels = terminal.labels ?? {};
  return {
    terminal_id: terminal.address, pane_id: terminal.address,
    agent: labels[LABELS.agent], binding: labels[LABELS.binding],
    agent_session: { value: labels[LABELS.session] },
    name: labels[LABELS.task] ?? null, state: terminal.state,
  };
}

export class Hc {
  constructor(env = process.env, store, run = execute) {
    this.env = env;
    this.store = store;
    this.run = run;
  }
  async command(args) {
    try {
      const { stdout } = await this.run('hc', [...args, '--json'], {
        env: this.env, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch { throw new Error('target_cli_failed'); }
  }
  async get(target) { return normalize(await this.command(['get', target])); }
  async list() {
    const { terminals } = await this.command(['ls']);
    // ls omits labels; get supplies authoritative binding and task labels.
    return Promise.all(terminals.map(({ address }) => this.get(address)));
  }
  async bind(target, agent, path) {
    if (!supportedAgents.includes(agent)) throw new Error('target_unsupported_session');
    if (!isAbsolute(path)) throw new Error('session_nonlocal_path');
    const terminal = await this.get(target);
    const release = await this.store.targetLock(terminal.terminal_id);
    try {
      const fresh = await this.get(terminal.terminal_id);
      if (fresh.state !== 'live') throw new Error('target_changed');
      if (fresh.agent === agent && sessionPath(fresh) === path && fresh.binding) return fresh;
      await this.command(['label', fresh.terminal_id,
        `${LABELS.agent}=${agent}`, `${LABELS.session}=${path}`, `${LABELS.binding}=${randomUUID()}`]);
      return this.get(fresh.terminal_id);
    } finally { await release(); }
  }
  async unbind(target, expectedPath) {
    const terminal = await this.get(target);
    const release = await this.store.targetLock(terminal.terminal_id);
    try {
      const fresh = await this.get(terminal.terminal_id);
      if (expectedPath && sessionPath(fresh) !== expectedPath) return 'superseded';
      await this.command(['label', fresh.terminal_id,
        `${LABELS.agent}=`, `${LABELS.session}=`, `${LABELS.binding}=`]);
      return 'unbound';
    } finally { await release(); }
  }
  async rename(target, name, request, observedName) {
    // Bind and final writes share this short lock; provider latency holds no target lock.
    const release = await this.store.targetLock(target);
    try {
      const fresh = await this.get(target);
      if (fresh.state !== 'live' || fresh.binding !== request.binding ||
          fresh.agent !== request.agent || sessionPath(fresh) !== request.path) throw new Error('target_changed');
      if (fresh.name !== observedName) throw new Error('target_name_changed');
      if (await this.store.hasControl(target, request.id)) throw new Error('request_superseded');
      await this.command(['label', target, `${LABELS.task}=${name}`]);
    } finally { await release(); }
  }
}
