import test from 'node:test';
import assert from 'node:assert/strict';
import { processRequest } from '../src/engine.mjs';
import { hash, parseSession } from '../src/pi-session.mjs';

function fixture() {
  const f = {
    agents: [{ agent: 'pi', terminal_id: 't1', pane_id: 'w1:p1', agent_session: { agent: 'pi', kind: 'path', value: '/session' } }],
    snapshot: { sessionId: 's1', fileIdentity: '1:1', version: 'v1', messages: [{ id: 'u1', text: 'Fix login' }] },
    saved: null, calls: 0, renames: 0, control: false,
    decision: { decision: 'new_task', summary: 'Fix login', name: 'fix-login' },
    request: { id: 'request', action: 'check', terminalId: 't1', path: '/session' },
  };
  f.deps = {
    hc: {
      list: async () => structuredClone(f.agents),
      rename: async (paneId, name) => { f.renames++; f.agents.find((a) => a.pane_id === paneId).name = name; },
    },
    readSession: async () => structuredClone(f.snapshot),
    store: {
      load: async () => structuredClone(f.saved),
      save: async (_, value) => { f.saved = structuredClone(value); },
      hasControl: async () => f.control,
    },
    classify: async (input) => { f.calls++; f.input = input; return f.decision; },
  };
  f.run = (action = 'check') => processRequest({ ...f.request, action }, f.deps);
  f.add = (text = 'Continue') => {
    const id = `u${f.snapshot.messages.length + 1}`;
    f.snapshot.messages.push({ id, text }); f.snapshot.version = id;
  };
  return f;
}

test('first task renames, duplicate checks do not call the model, continuation keeps name', async () => {
  const f = fixture();
  assert.equal(await f.run(), 'renamed');
  assert.equal(await f.run(), 'unchanged');
  assert.equal(f.calls, 1);
  f.add('Add tests and commit');
  f.decision = { decision: 'same_task', summary: 'Fix login with tests', name: 'fix-login' };
  assert.equal(await f.run(), 'same_task');
  assert.equal(f.renames, 1);
  f.add('Now fix payment timeout');
  f.decision = { decision: 'new_task', summary: 'Fix payment timeout', name: 'fix-payment' };
  assert.equal(await f.run(), 'renamed');
  assert.equal(f.agents[0].name, 'fix-payment');
});

test('uncertain and image-only messages preserve the name', async () => {
  const f = fixture();
  f.decision = { decision: 'uncertain', summary: '', name: '' };
  assert.equal(await f.run(), 'uncertain');
  assert.equal(f.renames, 0);
  f.add('');
  assert.equal(await f.run(), 'no_text');
  assert.equal(f.calls, 1);
});

test('pause, explicit one-off rename, and resume have distinct semantics', async () => {
  const f = fixture();
  assert.equal(await f.run('pause'), 'paused');
  assert.equal(await f.run(), 'paused');
  assert.equal(f.calls, 0);
  assert.equal(await f.run('rename'), 'renamed');
  assert.equal(f.saved.paused, true);
  assert.equal(await f.run('resume'), 'renamed');
  assert.equal(f.saved.paused, false);
});

test('external names pause automation, including edits during the model call', async () => {
  const f = fixture();
  await f.run();
  f.agents[0].name = 'manual';
  assert.equal(await f.run(), 'external_name_paused');
  f.add();
  assert.equal(await f.run(), 'paused');
  const g = fixture();
  g.deps.classify = async () => { g.agents[0].name = 'manual'; return g.decision; };
  assert.equal(await g.run(), 'external_name_paused');
  assert.equal(g.renames, 0);
});

test('model-time message changes and queued controls discard stale results', async () => {
  const f = fixture();
  f.deps.classify = async () => { f.add('New goal'); return f.decision; };
  assert.equal(await f.run(), 'stale_result');
  assert.equal(f.renames, 0);
  const g = fixture(); g.control = true;
  assert.equal(await g.run(), 'superseded');
  assert.equal(g.renames, 0);
});

test('session switches reject old results and shared session panes are refused', async () => {
  const f = fixture();
  f.deps.classify = async () => { f.agents[0].agent_session.value = '/other'; return f.decision; };
  await assert.rejects(f.run(), /target_changed/);
  assert.equal(f.renames, 0);
  const g = fixture();
  g.agents.push({ ...structuredClone(g.agents[0]), pane_id: 'w2:p2', terminal_id: 't2' });
  await assert.rejects(g.run(), /shared_session/);
});

test('agent kind changes reject stale results and session keys stay isolated', async () => {
  const f = fixture();
  f.deps.classify = async () => {
    f.agents[0].agent = 'claude';
    f.agents[0].agent_session.agent = 'claude';
    return f.decision;
  };
  await assert.rejects(f.run(), /target_changed/);
  assert.equal(f.renames, 0);
  const g = fixture();
  g.request.agent = 'kimi';
  g.agents[0].agent = 'kimi';
  g.agents[0].agent_session.agent = 'kimi';
  g.agents.push({ agent: 'claude', terminal_id: 't2', pane_id: 'w1:p2',
    agent_session: { agent: 'claude', kind: 'path', value: '/session' } });
  const save = g.deps.store.save;
  g.deps.store.save = async (key, value) => {
    assert.deepEqual(JSON.parse(key), ['kimi', '/session', null]);
    await save(key, value);
  };
  g.deps.readSession = async (value, agent) => {
    assert.equal(value, '/session');
    assert.equal(agent, 'kimi');
    return structuredClone(g.snapshot);
  };
  assert.equal(await g.run(), 'renamed');
});

test('pane moves follow terminal identity', async () => {
  const f = fixture();
  f.deps.classify = async () => { f.agents[0].pane_id = 'w2:p4'; return f.decision; };
  assert.equal(await f.run(), 'renamed');
});

test('rename failure retains generated result and retries without another model call', async () => {
  const f = fixture();
  const rename = f.deps.hc.rename;
  f.deps.hc.rename = async () => { throw new Error('target_cli_failed'); };
  await assert.rejects(f.run(), /cli_failed/);
  assert.equal(f.saved.pending.name, 'fix-login');
  f.deps.hc.rename = rename;
  assert.equal(await f.run(), 'renamed');
  assert.equal(f.calls, 1);
});

test('rename applied but response lost recovers by reading actual name', async () => {
  const f = fixture();
  f.deps.hc.rename = async (_, name) => { f.agents[0].name = name; throw new Error('target_cli_failed'); };
  await assert.rejects(f.run(), /cli_failed/);
  assert.equal(await f.run(), 'unchanged');
  assert.equal(f.saved.paused, false);
  assert.equal(f.saved.pending, null);
  assert.equal(f.calls, 1);
});

test('persisted branch changes exclude previous task summary', async () => {
  const f = fixture();
  await f.run();
  f.snapshot.messages = [{ id: 'different', text: 'Fix database' }]; f.snapshot.version = 'branch2';
  await f.run();
  assert.equal(f.input.summary, '');
  assert.equal(f.input.branchChanged, true);
});

test('image-only branch clears the previous summary before later text input', async () => {
  const f = fixture();
  await f.run();
  f.snapshot.messages = [{ id: 'image-branch', text: '' }];
  f.snapshot.version = 'image-branch';
  assert.equal(await f.run(), 'no_text');
  assert.equal(f.saved.summary, '');
  assert.equal(f.agents[0].name, 'fix-login');
  f.add('Describe this image');
  await f.run();
  assert.equal(f.input.summary, '');
});

test('image-only continuation preserves the existing task summary', async () => {
  const f = fixture();
  await f.run();
  f.add('');
  assert.equal(await f.run(), 'no_text');
  assert.equal(f.saved.summary, 'Fix login');
});

test('model errors preserve progress and old name', async () => {
  const f = fixture();
  f.deps.classify = async () => { throw new Error('model_unavailable'); };
  await assert.rejects(f.run(), /model_unavailable/);
  assert.equal(f.saved.version, null);
  assert.equal(f.saved.error, 'model_unavailable');
  assert.equal(f.renames, 0);
});

test('name collisions get a bounded suffix', async () => {
  const f = fixture();
  f.agents.push({ agent: 'codex', terminal_id: 't2', pane_id: 'w1:p2', name: 'fix-login' });
  await f.run();
  assert.match(f.agents[0].name, /^fix-login-[0-9a-f]{4}$/);
});

test('manual rename retries and completed queue replay reuse the saved decision', async () => {
  const f = fixture();
  const rename = f.deps.hc.rename;
  f.deps.hc.rename = async () => { throw new Error('target_cli_failed'); };
  await assert.rejects(f.run('rename'), /cli_failed/);
  f.deps.hc.rename = rename;
  assert.equal(await f.run('rename'), 'renamed');
  assert.equal(await f.run('rename'), 'unchanged');
  assert.equal(f.calls, 1);
  assert.equal(f.renames, 1);
});

test('restored terminal identity is saved before unchanged return, protecting later manual edits', async () => {
  const f = fixture();
  await f.run();
  f.agents[0].terminal_id = 't2'; f.request.terminalId = 't2';
  delete f.agents[0].name;
  assert.equal(await f.run(), 'unchanged');
  assert.equal(f.saved.terminalId, 't2');
  f.agents[0].name = 'manual'; f.add();
  assert.equal(await f.run(), 'external_name_paused');
  assert.equal(f.renames, 1);
});

test('newer pause supersedes an in-flight manual rename and does not regenerate on recovery', async () => {
  const f = fixture();
  f.deps.classify = async () => { f.control = true; f.calls++; return f.decision; };
  assert.equal(await f.run('rename'), 'superseded');
  f.control = false;
  await f.run('pause');
  assert.equal(await f.run(), 'paused');
  assert.equal(f.renames, 0);
  assert.equal(f.calls, 1);
});

test('failed old manual request cannot cross a newer completed pause', async () => {
  const f = fixture();
  f.request.id = '001';
  f.deps.classify = async () => { throw new Error('model_unavailable'); };
  await assert.rejects(f.run('rename'), /model_unavailable/);
  f.request.id = '002';
  assert.equal(await f.run('pause'), 'paused');
  f.request.id = '001';
  assert.equal(await f.run('rename'), 'superseded');
  assert.equal(f.saved.paused, true);
  assert.equal(f.renames, 0);
});


for (const action of ['check', 'rename', 'resume']) {
  test(`latest three combined messages bound ${action} context`, async () => {
    const f = fixture();
    f.snapshot.messages = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `Message ${i}`,
    }));
    await f.run(action);
    assert.deepEqual([...f.input.recentMessages, ...f.input.newMessages], f.snapshot.messages.slice(-3));
    assert.deepEqual(f.saved.processed, f.snapshot.messages.map(m => m.id));
  });
}

test('incremental assistant replies and branch changes use a combined three-message window', async () => {
  const f = fixture();
  await f.run();
  for (let i = 0; i < 5; i++) f.add(`Follow-up ${i}`);
  await f.run();
  assert.deepEqual([...f.input.recentMessages, ...f.input.newMessages], f.snapshot.messages.slice(-3));
  f.snapshot.messages.push({ id: 'reply', role: 'assistant', text: 'Suggested next step' });
  f.snapshot.version = 'reply';
  await f.run();
  assert.equal(f.input.newMessages[0].role, 'assistant');
  assert.equal(f.input.recentMessages.length, 2);
  f.snapshot.messages = f.snapshot.messages.slice(-4);
  f.snapshot.version = 'branch';
  await f.run();
  assert.equal(f.input.summary, '');
  assert.deepEqual(f.input.recentMessages, []);
  assert.deepEqual(f.input.newMessages, f.snapshot.messages.slice(-3));
});

// Exercise the engine with real branch traversal and content-derived revisions.
function parsedFixture() {
  const f = fixture();
  f.entries = [];
  f.append = (id, role, text, parentId = f.entries.at(-1)?.id ?? null) => {
    f.entries.push({ type: 'message', id, parentId, message: { role, content: text } });
  };
  f.parse = () => ({
    ...parseSession([{ type: 'session', version: 3, id: 's1' }, ...f.entries].map(JSON.stringify).join('\n') + '\n'),
    fileIdentity: '1:1',
  });
  f.deps.readSession = async () => f.parse();
  f.legacyProgress = () => {
    const users = f.parse().messages.filter(m => m.role === 'user').map(({ id, text }) => ({ id, text }));
    f.agents[0].name = 'fix-login';
    f.saved = {
      schema: 1, paused: false, summary: 'Fix login', processed: users.map(m => m.id),
      version: hash(JSON.stringify(['s1', users])), observedName: 'fix-login', terminalId: 't1', pending: null,
    };
  };
  return f;
}

for (const action of ['check', 'rename', 'resume']) {
  test(`parsed session retains latest user goal after three assistant replies on ${action}`, async () => {
    const f = parsedFixture();
    f.append('u1', 'user', 'Fix login');
    f.append('a1', 'assistant', 'Investigating login');
    f.append('a2', 'assistant', 'Found the login bug');
    f.append('a3', 'assistant', 'We could also improve payments');
    assert.equal(await f.run(action), 'renamed');
    assert.deepEqual(f.input.recentMessages, []);
    assert.deepEqual(f.input.newMessages, f.parse().messages.filter(m => m.id !== 'a1'));
    assert.deepEqual(f.saved.processed, ['u1', 'a1', 'a2', 'a3']);
    assert.equal(await f.run(action), 'unchanged');
    assert.equal(f.calls, 1);
  });
}

test('parsed incremental window retains an unprocessed user goal and later keeps it as recent context', async () => {
  const f = parsedFixture();
  f.append('u1', 'user', 'Fix login');
  await f.run();
  f.append('u2', 'user', 'Next, fix payment timeouts');
  for (let i = 1; i <= 3; i++) f.append(`a${i}`, 'assistant', `Payment investigation ${i}`);
  f.decision = { decision: 'new_task', summary: 'Fix payment timeouts', name: 'fix-payment' };
  assert.equal(await f.run(), 'renamed');
  assert.deepEqual(f.input.recentMessages, []);
  assert.deepEqual(f.input.newMessages.map(m => m.id), ['u2', 'a2', 'a3']);
  assert.equal(f.input.summary, 'Fix login');
  assert.equal(f.input.branchChanged, false);
  assert.deepEqual(f.saved.processed, ['u1', 'u2', 'a1', 'a2', 'a3']);

  f.append('a4', 'assistant', 'Payment tests pass');
  f.decision = { decision: 'same_task', summary: 'Fix payment timeouts', name: '' };
  assert.equal(await f.run(), 'same_task');
  assert.deepEqual(f.input.recentMessages.map(m => m.id), ['u2', 'a3']);
  assert.deepEqual(f.input.newMessages.map(m => m.id), ['a4']);
});

for (const appendReply of [false, true]) {
  test(`legacy user-only progress preserves summary and uses last matched boundary, reply=${appendReply}`, async () => {
    const f = parsedFixture();
    f.append('u1', 'user', 'Fix login');
    f.append('a1', 'assistant', 'Checking the handler');
    f.append('u2', 'user', 'Add tests');
    f.legacyProgress();
    if (appendReply) f.append('a2', 'assistant', 'Login tests pass');
    f.decision = { decision: 'same_task', summary: 'Fix login', name: '' };
    assert.equal(await f.run(), appendReply ? 'same_task' : 'no_text');
    assert.equal(f.saved.summary, 'Fix login');
    assert.deepEqual(f.saved.processed, f.parse().messages.map(m => m.id));
    assert.equal(f.renames, 0);
    if (appendReply) {
      assert.equal(f.input.branchChanged, false);
      assert.equal(f.input.summary, 'Fix login');
      assert.deepEqual(f.input.recentMessages.map(m => m.id), ['a1', 'u2']);
      assert.deepEqual(f.input.newMessages.map(m => m.id), ['a2']);
    }
    assert.equal(await f.run(), 'unchanged');
    assert.equal(f.calls, appendReply ? 1 : 0);
  });
}

for (const legacy of [false, true]) {
  test(`parsed sibling branch clears summary with legacy progress=${legacy}`, async () => {
    const f = parsedFixture();
    f.append('root', 'user', 'Work on the app');
    f.append('u1', 'user', 'Fix login');
    f.append('a1', 'assistant', 'Checking login');
    f.append('u2', 'user', 'Add tests');
    if (legacy) f.legacyProgress();
    else await f.run();
    f.append('fork', 'assistant', 'Let us inspect the database', 'root');
    f.append('goal', 'user', 'Fix database connections');
    f.decision = { decision: 'uncertain', summary: 'Ignored', name: '' };
    assert.equal(await f.run(), 'uncertain');
    assert.equal(f.input.branchChanged, true);
    assert.equal(f.input.summary, '');
    assert.deepEqual(f.input.recentMessages, []);
    assert.deepEqual(f.input.newMessages.map(m => m.id), ['root', 'fork', 'goal']);
    assert.equal(f.saved.summary, '');
    assert.deepEqual(f.saved.processed, ['root', 'fork', 'goal']);
  });
}

for (const changedIds of [['u1', 'u2'], ['u1', 'a1'], ['u2', 'a1', 'u1']]) {
  test(`parsed replacement resets progress for missing or reordered IDs: ${changedIds}`, async () => {
    const f = parsedFixture();
    const messages = { u1: ['user', 'Fix login'], a1: ['assistant', 'Checking login'], u2: ['user', 'Add tests'] };
    for (const id of ['u1', 'a1', 'u2']) f.append(id, ...messages[id]);
    await f.run();
    f.entries = [];
    for (const id of changedIds) f.append(id, ...messages[id]);
    f.decision = { decision: 'uncertain', summary: '', name: '' };
    assert.equal(await f.run(), 'uncertain');
    assert.equal(f.input.branchChanged, true);
    assert.equal(f.input.summary, '');
    assert.equal(f.saved.summary, '');
  });
}

for (const decision of ['new_task', 'same_task']) {
  test(`parsed assistant append during ${decision} model call discards result and progress`, async () => {
    const f = parsedFixture();
    f.append('u1', 'user', 'Fix login');
    await f.run();
    const before = structuredClone(f.saved);
    f.append('u2', 'user', 'Add tests');
    f.decision = { decision, summary: 'Fix login with tests', name: decision === 'new_task' ? 'test-login' : '' };
    const classify = f.deps.classify;
    f.deps.classify = async input => {
      f.append('a1', 'assistant', 'Tests exposed another login bug');
      return classify(input);
    };
    assert.equal(await f.run(), 'stale_result');
    assert.deepEqual(f.saved, before);
    assert.equal(f.renames, 1);
    f.deps.classify = classify;
    assert.equal(await f.run(), decision === 'new_task' ? 'renamed' : 'same_task');
    assert.deepEqual(f.input.newMessages.map(m => m.id), ['u2', 'a1']);
    assert.deepEqual(f.saved.processed, ['u1', 'u2', 'a1']);
    assert.equal(f.saved.version, f.parse().version);
    assert.equal(f.calls, 3);
  });
}

for (const duringRetry of [false, true]) {
  test(`parsed assistant append invalidates pending rename, during retry=${duringRetry}`, async () => {
    const f = parsedFixture();
    f.append('u1', 'user', 'Fix login');
    await f.run();
    const before = structuredClone(f.saved);
    f.append('u2', 'user', 'Add tests');
    f.decision = { decision: 'new_task', summary: 'Test login', name: 'test-login' };
    const rename = f.deps.hc.rename;
    f.deps.hc.rename = async () => { throw new Error('target_cli_failed'); };
    await assert.rejects(f.run(), /cli_failed/);
    assert.equal(f.saved.pending.name, 'test-login');
    assert.equal(f.saved.version, before.version);
    assert.deepEqual(f.saved.processed, before.processed);
    f.deps.hc.rename = rename;
    if (duringRetry) {
      let reads = 0;
      f.deps.readSession = async () => {
        if (++reads === 2) f.append('a1', 'assistant', 'Login tests pass');
        return f.parse();
      };
      assert.equal(await f.run(), 'stale_result');
      assert.equal(f.calls, 2);
      assert.equal(f.renames, 1);
      assert.equal(f.saved.version, before.version);
      assert.deepEqual(f.saved.processed, before.processed);
      f.deps.readSession = async () => f.parse();
    } else f.append('a1', 'assistant', 'Login tests pass');
    f.decision = { decision: 'same_task', summary: 'Fix login with tests', name: '' };
    assert.equal(await f.run(), 'same_task');
    assert.equal(f.input.summary, 'Fix login');
    assert.deepEqual(f.input.newMessages.map(m => m.id), ['u2', 'a1']);
    assert.equal(f.saved.pending, null);
    assert.deepEqual(f.saved.processed, ['u1', 'u2', 'a1']);
    assert.equal(f.saved.version, f.parse().version);
    assert.equal(f.saved.summary, 'Fix login with tests');
    assert.equal(f.agents[0].name, 'fix-login');
    assert.equal(f.renames, 1);
    assert.equal(f.calls, 3);
  });
}


test('binding generation rejects an ABA session switch during classification', async () => {
  const f = fixture();
  f.request.binding = 'old';
  f.agents[0].binding = 'old';
  f.deps.classify = async () => { f.agents[0].binding = 'new'; return f.decision; };
  await assert.rejects(f.run(), /target_changed/);
  assert.equal(f.renames, 0);
});

test('pause works before a newly bound session file exists', async () => {
  const f = fixture();
  f.deps.readSession = async () => { throw new Error('session_not_ready'); };
  assert.equal(await f.run('pause'), 'paused');
  assert.equal(await f.run(), 'paused');
  assert.equal(f.calls, 0);
});

test('tool-only updates do not call the naming provider', async () => {
  const f = parsedFixture();
  f.append('u1', 'user', 'Fix login');
  await f.run();
  f.entries.push({ type: 'message', id: 'tool-call', parentId: 'u1', message: {
    role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }],
  } });
  f.append('tool-result', 'toolResult', 'large tool output');
  assert.equal(await f.run(), 'unchanged');
  assert.equal(f.calls, 1);
});


test('a first snapshot on a new binding identifies its goal independently of an old task label', async () => {
  const f = fixture();
  f.agents[0].name = 'previous-session-task';
  await f.run();
  assert.equal(f.input.currentName, '');
  assert.equal(f.agents[0].name, 'fix-login');
});
