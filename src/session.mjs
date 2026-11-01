import { basename, dirname, isAbsolute, join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { hash, parseSession as parsePi, readSession as readFileSession } from './pi-session.mjs';

export const supportedAgents = ['pi', 'claude', 'codex', 'kimi'];

function textContent(content, types = ['text']) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((part) => types.includes(part.type) && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
}

// Kimi 2.3.3: wire protocol 1.5, wire/tree/{tree,fork}.ts and contextMemory/loopEventFold.ts.
function kimiActiveChain(entries) {
  const branches = new Map([['main', { from: 1 }]]);
  const pairedUndo = new Set();
  let active = 'main';
  for (const { record, line } of entries) {
    if (record.type !== 'agent.switched' || (record.agentId && record.agentId !== 'main')) continue;
    const { branch, base, legacyUndoLine } = record;
    const parent = branches.get(base?.branch);
    if (typeof branch !== 'string' || !branch || branches.has(branch) || !parent ||
        !Number.isSafeInteger(base.line) || base.line < parent.from - 1 ||
        base.line > (parent.to ?? line - 1) ||
        (legacyUndoLine !== undefined && legacyUndoLine !== line + 1)) {
      throw new Error('session_invalid_tree');
    }
    branches.get(active).to = line - 1;
    branches.set(branch, { from: line + 1, base });
    active = branch;
    if (legacyUndoLine !== undefined) pairedUndo.add(legacyUndoLine);
  }
  const ranges = [];
  let upto = entries.at(-1).line;
  while (active) {
    const segment = branches.get(active);
    ranges.push([segment.from, upto]);
    upto = segment.base?.line;
    active = segment.base?.branch;
  }
  const chain = [];
  for (const [from, to] of ranges.reverse()) {
    for (const entry of entries) {
      if (entry.line < from || entry.line > to || entry.record.type === 'agent.switched') continue;
      if (entry.record.type === 'context.undo' && pairedUndo.has(entry.line)) continue;
      chain.push(entry);
    }
  }
  return chain;
}

function kimiUserOrigin(origin) {
  return !origin || origin.kind === 'user' ||
    (['skill_activation', 'plugin_command'].includes(origin.kind) && origin.trigger === 'user-slash');
}

function parseKimiWire(entries) {
  if (entries[0].record.protocol_version !== '1.5') throw new Error('session_unsupported_format');
  const messages = [];
  const seen = new Map();
  let open;
  let undoFloor = 0;
  const remember = (key, index = messages.length) => {
    if (seen.has(key)) return false;
    seen.set(key, index);
    return true;
  };
  const forgetAfter = (cut) => {
    for (const [key, index] of seen) if (index >= cut) seen.delete(key);
  };
  const partsText = (parts) => (Array.isArray(parts) ? parts : [])
    .filter((part) => part.type === 'text').map((part) => part.text).join('');
  for (const { record, line } of kimiActiveChain(entries)) {
    if (record.agentId && record.agentId !== 'main') continue;
    if (record.type === 'context.append_message') {
      const message = record.message;
      if (!['user', 'assistant'].includes(message?.role)) continue;
      const key = `message:${message.id ?? line}`;
      if (!remember(key)) continue;
      messages.push({ key, role: message.role, text: partsText(message.content),
        visible: message.role === 'user' ? kimiUserOrigin(message.origin) : !message.origin,
        anchor: message.role === 'user' && kimiUserOrigin(message.origin) && message.origin?.inTurn !== true });
    } else if (record.type === 'context.append_loop_event') {
      const event = record.event;
      if (event.type === 'step.begin') {
        if (!remember(`step.begin:${event.uuid}`)) continue;
        open = { key: `step:${event.uuid}`, role: 'assistant', text: '', visible: true,
          step: event.uuid, index: messages.length };
        messages.push(open);
      } else if (event.type === 'content.part' && open && open.step === event.stepUuid) {
        if (event.uuid && !remember(`content.part:${event.uuid}`, open.index)) continue;
        if (event.part.type === 'text') open.text += event.part.text;
      } else if (event.type === 'step.end' && open?.step === event.uuid &&
          !['interrupted', 'error'].includes(event.finishReason)) {
        open = undefined;
      }
    } else if (record.type === 'context.undo') {
      if (!Number.isSafeInteger(record.count) || record.count <= 0) throw new Error('session_unsupported_format');
      let remaining = record.count;
      let cut = messages.length;
      while (cut > undoFloor && remaining > 0) {
        if (messages[--cut].anchor) remaining--;
      }
      messages.splice(cut);
      forgetAfter(cut);
      open = undefined;
    } else if (record.type === 'context.clear' || record.type === 'context.apply_compaction') {
      // These reset model context, but the transcript retains the original dialogue.
      // Legacy undo must stop here; branch switches already select their exact base line.
      undoFloor = messages.length;
      open = undefined;
    }
  }
  return messages.filter((message) => message.visible && (message.role === 'user' || message.text.trim()))
    .map(({ key, role, text }) => ({ id: `${key}:${hash(text)}`, role, text }));
}

async function readKimiIdentity(directory, sessionId) {
  let state;
  try { state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('session_invalid_json');
    throw error;
  }
  if (state.id !== sessionId || (state.agents?.main?.type && state.agents.main.type !== 'main') ||
      state.agents?.main?.parentAgentId) throw new Error('session_identity_mismatch');
}

export async function resolveKimiSessionPath(sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId === '.' || sessionId === '..' ||
      /[/\\\0]/.test(sessionId)) throw new Error('session_identity_mismatch');
  const home = env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code');
  if (!isAbsolute(home)) throw new Error('session_nonlocal_path');
  const sessions = join(home, 'sessions');
  const matches = [];
  for (const workspace of await readdir(sessions, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const directory = join(sessions, workspace.name, sessionId);
    try { if ((await stat(directory)).isDirectory()) matches.push(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (matches.length > 1) throw new Error('session_identity_ambiguous');
  if (!matches.length) throw new Error('session_not_ready');
  await readKimiIdentity(matches[0], sessionId);
  return join(matches[0], 'agents', 'main', 'wire.jsonl');
}

export function parseSession(text, agent, sessionId) {
  if (agent === 'pi') return parsePi(text);
  const end = text.lastIndexOf('\n');
  let records, numbered;
  try {
    numbered = text.slice(0, end + 1).split('\n').map((line, index) => ({ text: line, line: index + 1 }))
      .filter((entry) => entry.text.trim()).map(({ text, line }) => ({ record: JSON.parse(text), line }));
    records = numbered.map(({ record }) => record);
  } catch { throw new Error('session_invalid_json'); }
  if (!records.length) throw new Error('session_not_ready');
  let messages = [];
  const add = (id, role, text) => {
    if (role === 'user' || (role === 'assistant' && text.trim())) messages.push({ id, role, text });
  };
  if (agent === 'claude') {
    const index = new Map();
    let leaf;
    for (const entry of records) {
      if (entry.sessionId && entry.sessionId !== sessionId) throw new Error('session_identity_mismatch');
      if (entry.uuid && !entry.isSidechain) { index.set(entry.uuid, entry); leaf = entry; }
    }
    if (!leaf) throw new Error('session_not_ready');
    const branch = [];
    const seen = new Set();
    while (leaf) {
      if (seen.has(leaf.uuid)) throw new Error('session_invalid_tree');
      seen.add(leaf.uuid);
      branch.push(leaf);
      // Compaction summaries are synthetic; retain the original user goal instead.
      leaf = index.get(leaf.parentUuid ?? leaf.logicalParentUuid);
    }
    for (const entry of branch.reverse()) {
      if (!['user', 'assistant'].includes(entry.type) || entry.isMeta || entry.isCompactSummary) continue;
      const content = entry.message?.content;
      // Tool-result wrappers are not user requests.
      if (Array.isArray(content) && content.some((part) => part.type === 'tool_result')) continue;
      add(entry.uuid, entry.message?.role, textContent(content));
    }
  } else if (agent === 'codex') {
    if (records[0].type !== 'session_meta' || records[0].payload?.id !== sessionId) {
      throw new Error('session_identity_mismatch');
    }
    for (const [i, entry] of records.entries()) {
      const item = entry.payload;
      if (entry.type === 'event_msg' && item?.type === 'thread_rolled_back') {
        let count = item.num_turns;
        if (!Number.isInteger(count) || count < 0) throw new Error('session_unsupported_format');
        while (count-- > 0) {
          const at = messages.findLastIndex((message) => message.role === 'user');
          if (at < 0) { messages = []; break; }
          messages.splice(at);
        }
      }
      // Rollout response items preserve actual conversation across compaction.
      // replacement_history is model context and includes synthetic summaries.
      if (entry.type !== 'response_item' || item?.type !== 'message') continue;
      const text = textContent(item.content, ['input_text', 'output_text']);
      // Codex persists startup instructions as user messages.
      if (item.role === 'user' && /^\s*(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>)/.test(text)) continue;
      add(`${i}:${hash(JSON.stringify(item))}`, item.role, text);
    }
  } else if (agent === 'kimi' && records[0].type === 'metadata') {
    messages = parseKimiWire(numbered);
  } else if (agent === 'kimi') {
    if (!records.some((entry) => ['_system_prompt', '_checkpoint', 'user', 'assistant'].includes(entry.role))) {
      throw new Error('session_unsupported_format');
    }
    for (const [i, entry] of records.entries()) {
      add(`${i}:${hash(JSON.stringify(entry))}`, entry.role, textContent(entry.content));
    }
  } else throw new Error('session_unsupported_format');
  return { sessionId, messages, version: hash(JSON.stringify([sessionId, messages])), partial: end < text.length - 1 };
}

export async function resolveSessionPath(value, agent) {
  if (!supportedAgents.includes(agent)) throw new Error('target_unsupported_session');
  if (!isAbsolute(value)) throw new Error('session_nonlocal_path');
  return value;
}

export async function readSession(value, agent = 'pi') {
  const path = await resolveSessionPath(value, agent);
  let sessionId;
  if (agent === 'kimi') {
    if (basename(path) === 'wire.jsonl') {
      if (basename(dirname(path)) !== 'main' || basename(dirname(dirname(path))) !== 'agents') {
        throw new Error('session_identity_mismatch');
      }
      const directory = dirname(dirname(dirname(path)));
      sessionId = basename(directory);
      await readKimiIdentity(directory, sessionId);
    } else sessionId = basename(dirname(path));
  }
  return readFileSession(path, (text) => {
    // Explicit paths carry their identity in the transcript header.
    let id = sessionId;
    if (!id && agent !== 'pi') {
      try {
        const records = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
        id = agent === 'codex' ? records[0]?.payload?.id : records.find((record) => record.sessionId)?.sessionId;
      } catch { throw new Error('session_invalid_json'); }
      if (!id) throw new Error('session_not_ready');
    }
    return parseSession(text, agent, id);
  });
}
