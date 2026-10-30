import { isAbsolute } from 'node:path';
import { hash, parseSession as parsePi, readSession as readFileSession } from './pi-session.mjs';

export const supportedAgents = ['pi', 'claude', 'codex', 'kimi'];

function textContent(content, types = ['text']) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((part) => types.includes(part.type) && typeof part.text === 'string')
    .map((part) => part.text).join('\n');
}

export function parseSession(text, agent, sessionId) {
  if (agent === 'pi') return parsePi(text);
  const end = text.lastIndexOf('\n');
  let records;
  try { records = text.slice(0, end + 1).split('\n').filter((line) => line.trim()).map(JSON.parse); }
  catch { throw new Error('session_invalid_json'); }
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
  const sessionId = agent === 'kimi' ? path.split('/').at(-2) : undefined;
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
