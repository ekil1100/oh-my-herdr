import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, loadConfig } from '../src/naming.mjs';

const config = {
  provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'deepseek-private',
  classifier: { provider: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', apiKey: 'typesafe-private' },
};
const input = { summary: 'Fix login', currentName: 'fix-login', newMessages: [{ text: 'Continue' }] };
const choice = (value) => new Response(JSON.stringify({ answers: { task: {
  type: 'choice', choice: value, confidence: 1,
  probabilities: { same_task: value === 'same_task' ? 1 : 0, new_task: value === 'new_task' ? 1 : 0, uncertain: value === 'uncertain' ? 1 : 0 },
} } }));
const generated = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
  decision: 'new_task', summary: 'Fix payment', name: 'fix-payment',
}) } }] }));

test('providers resolve service URLs and conventional credential variables', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-name-provider-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = (value) => writeFile(join(directory, 'config.json'), JSON.stringify(value));
  const env = { DEEPSEEK_API_KEY: 'deepseek-key', TYPESAFE_API_KEY: 'typesafe-key', OPENAI_API_KEY: 'openai-key' };
  await save({ provider: 'deepseek', model: 'deepseek-flash', classifier: { provider: 'typesafe', model: 'jev-latest' } });
  const resolved = await loadConfig(directory, env);
  assert.equal(resolved.baseUrl, 'https://api.deepseek.com');
  assert.equal(resolved.apiKey, env.DEEPSEEK_API_KEY);
  assert.equal(resolved.classifier.baseUrl, 'https://api.typesafe.ai/v1');
  assert.equal(resolved.classifier.apiKey, env.TYPESAFE_API_KEY);
  await assert.rejects(loadConfig(directory, { DEEPSEEK_API_KEY: 'key' }), /credentials_missing/);
  await save({ provider: 'openai', model: 'test' });
  const normal = await loadConfig(directory, env);
  assert.equal(normal.apiKey, env.OPENAI_API_KEY);
  assert.equal(normal.classifier, null);
  for (const value of [null, { provider: 'unknown', model: 'x' }, { provider: 'typesafe', model: 'jev-latest' },
    { provider: 'deepseek', model: 'x', classifier: { provider: 'openai', model: 'x' } },
    { provider: 'deepseek', model: 'x', classifier: null },
    { provider: 'deepseek', model: 'x', apiKeyEnv: 'CUSTOM_KEY' }]) {
    await save(value);
    await assert.rejects(loadConfig(directory, env), /config_invalid/);
  }
});

for (const decision of ['same_task', 'uncertain']) {
  test(`Jev ${decision} preserves name without calling the naming model`, async () => {
    let calls = 0;
    const result = await classify(input, config, async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.headers.Authorization, 'Bearer typesafe-private');
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'jev-latest');
      assert.equal(payload.questions.task.type, 'choice');
      assert.equal(payload.state.summary, input.summary);
      return choice(decision);
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { decision, summary: input.summary, name: '' });
  });
}

test('Jev new_task uses the ordinary model to generate a name and redacts both provider keys', async () => {
  const urls = [];
  const result = await classify({ ...input, newMessages: [{ text: 'Fix payment deepseek-private typesafe-private' }] }, config, async (url, options) => {
    urls.push(url);
    assert.doesNotMatch(options.body, /deepseek-private|typesafe-private/);
    const body = JSON.parse(options.body);
    if (urls.length === 1) return choice('new_task');
    assert.equal(options.headers.Authorization, 'Bearer deepseek-private');
    assert.equal(JSON.parse(body.messages[1].content).force, true);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    return generated();
  });
  assert.deepEqual(urls, ['https://api.typesafe.ai/v1/systemone', 'https://api.deepseek.com/chat/completions']);
  assert.equal(result.name, 'fix-payment');
});

test('absent classifier and explicit manual requests use the ordinary model directly', async () => {
  for (const [request, settings] of [[input, { ...config, classifier: null }], [{ ...input, force: true }, config]]) {
    let calls = 0;
    await classify(request, settings, async (url) => {
      calls++;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      return generated();
    });
    assert.equal(calls, 1);
  }
});

test('configured Jev errors preserve failure behavior instead of silently changing services', async () => {
  for (const response of [() => new Response('secret body', { status: 503 }),
    () => new Response(JSON.stringify({ answers: { task: { type: 'choice', choice: 'unexpected' } } })),
    () => new Response(JSON.stringify(null))]) {
    let calls = 0;
    await assert.rejects(classify(input, config, async () => { calls++; return response(); }), /model_/);
    assert.equal(calls, 1);
  }
});
