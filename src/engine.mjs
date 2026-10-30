import { sessionPath } from './hc.mjs';
import { uniqueName, validateDecision } from './naming.mjs';
import { safeError } from './state.mjs';

function locate(agents, request) {
  const agent = agents.find((item) => item.terminal_id === request.terminalId);
  if (!agent || agent.agent !== (request.agent ?? 'pi') || sessionPath(agent) !== request.path || agent.binding !== request.binding) throw new Error('target_changed');
  if (agents.filter((item) => item.agent === agent.agent && item.agent_session?.value === request.path).length !== 1) {
    throw new Error('target_shared_session');
  }
  return agent;
}

function revision(snapshot) { return `${snapshot.fileIdentity}:${snapshot.version}`; }

export async function processRequest(request, { hc, store, readSession, classify, assertLock = () => {} }) {
  if (await store.hasControl(request.terminalId, request.id)) return 'superseded';
  const controlToken = `${request.id}:${request.action}`;
  let agents = await hc.list();
  let agent = locate(agents, request);
  const key = JSON.stringify([agent.agent, request.path, request.binding]);
  let state = await store.load(key) ?? {
    schema: 1, paused: false, summary: '', processed: [], version: null,
    observedName: agent.name ?? null, terminalId: agent.terminal_id, pending: null,
  };
  const save = async () => { assertLock(); await store.save(key, state); };
  if (state.latestControl && request.id < state.latestControl) return 'superseded';
  if (request.action !== 'check') state.latestControl = request.id;
  try {
    if (state.terminalId !== agent.terminal_id) {
      // A restored session may have a new occupant whose name was reset by hc.
      state.terminalId = agent.terminal_id;
      state.observedName = agent.name ?? null;
      state.pending = null;
      await save();
    }
    if (request.action === 'pause') {
      state.paused = true;
      state.pending = null;
      state.observedName = agent.name ?? null;
      await save();
      return 'paused';
    }
    if ((request.action === 'resume' || request.action === 'rename') && state.appliedControl !== controlToken) {
      if (request.action === 'resume') state.paused = false;
      state.observedName = agent.name ?? null;
      state.pending = null;
      state.appliedControl = controlToken;
      await save();
    }

    // Recover an acknowledged rename even if the process died before saving progress.
    if (state.pending && agent.name === state.pending.name) {
      state = { ...state, ...state.pending.next, observedName: agent.name, lastApplied: agent.name, pending: null };
      await save();
    }
    if ((agent.name ?? null) !== state.observedName) {
      state.paused = true;
      state.pending = null;
      state.observedName = agent.name ?? null;
      await save();
      return 'external_name_paused';
    }
    if (state.paused && request.action !== 'rename') return 'paused';
    const snapshot = await readSession(request.path, agent.agent);
    const force = request.action === 'rename' || request.action === 'resume';
    if (force && state.completedControl === controlToken) return 'unchanged';
    if (state.pending && state.pending.revision !== revision(snapshot)) {
      state.pending = null;
      await save();
    }
    if (!force && !state.pending && state.version === snapshot.version) return 'unchanged';

    const ids = snapshot.messages.map((m) => m.id);
    // Newly included assistant IDs may interleave legacy user-only progress.
    // Every processed ID must still occur in order on the current parent-linked branch.
    let matched = 0;
    let processedEnd = 0;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === state.processed[matched]) {
        matched++;
        processedEnd = i + 1;
      }
    }
    const continuation = matched === state.processed.length;
    const windowStart = Math.max(0, ids.length - 3);
    const windowIndexes = ids.slice(windowStart).map((_, i) => windowStart + i);
    const latestUserIndex = snapshot.messages.findLastIndex((message) => message.role === 'user');
    // Keep the latest user goal even when assistant replies fill the tail.
    if (latestUserIndex >= 0 && latestUserIndex < windowStart) windowIndexes[0] = latestUserIndex;
    const addedStart = force || !continuation ? 0 : processedEnd;
    const added = windowIndexes.filter((i) => i >= addedStart).map((i) => snapshot.messages[i]);
    if (!state.pending) {
      if (!added.some((message) => message.text.trim())) {
        state = { ...state, version: snapshot.version, processed: ids, error: 'session_no_text',
          summary: continuation ? state.summary : '',
          ...(force ? { completedControl: controlToken } : {}) };
        await save();
        return 'no_text';
      }
      const decision = validateDecision(await classify({
        summary: continuation ? state.summary : '',
        currentName: state.version === null ? '' : (agent.name ?? ''), force,
        recentMessages: windowIndexes.filter((i) => i < addedStart).map((i) => snapshot.messages[i]),
        newMessages: added, branchChanged: !continuation,
      }));
      const next = {
        version: snapshot.version, processed: ids,
        summary: decision.decision === 'uncertain' ? (continuation ? state.summary : '') : decision.summary,
        error: null,
        ...(force ? { completedControl: controlToken } : {}),
      };
      // Check messages, occupant, manual name, and queued controls after model latency.
      const freshAgents = await hc.list();
      const fresh = locate(freshAgents, request);
      const freshSnapshot = await readSession(request.path, agent.agent);
      if (await store.hasControl(request.terminalId, request.id)) return 'superseded';
      if (revision(freshSnapshot) !== revision(snapshot)) return 'stale_result';
      if ((fresh.name ?? null) !== state.observedName) {
        state.paused = true;
        state.observedName = fresh.name ?? null;
        await save();
        return 'external_name_paused';
      }
      if (decision.decision !== 'new_task') {
        state = { ...state, ...next };
        await save();
        return decision.decision;
      }
      agents = freshAgents;
      agent = fresh;
      state.pending = {
        name: uniqueName(decision.name, agents, agent.pane_id),
        revision: revision(snapshot), next,
      };
      // The write-ahead record precedes the CLI side effect.
      await save();
    }

    agents = await hc.list();
    agent = locate(agents, request);
    if (await store.hasControl(request.terminalId, request.id)) return 'superseded';
    if (revision(await readSession(request.path, agent.agent)) !== state.pending.revision) return 'stale_result';
    if ((agent.name ?? null) !== state.observedName) {
      state.paused = true;
      state.pending = null;
      state.observedName = agent.name ?? null;
      await save();
      return 'external_name_paused';
    }
    const candidate = uniqueName(state.pending.name, agents, agent.pane_id);
    if (candidate !== state.pending.name) {
      state.pending.name = candidate;
      await save();
    }
    assertLock();
    await hc.rename(agent.pane_id, state.pending.name, request, state.observedName);
    const after = locate(await hc.list(), request);
    if (after.name !== state.pending.name) throw new Error('rename_unconfirmed');
    state = { ...state, ...state.pending.next, observedName: after.name, lastApplied: after.name, pending: null };
    await save();
    return 'renamed';
  } catch (error) {
    state.error = safeError(error);
    await save();
    throw error;
  }
}
