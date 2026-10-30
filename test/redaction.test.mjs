import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/naming.mjs';

const config = {
  baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'key-with-"quotes\\and-newline\n',
  classifier: { baseUrl: 'https://classifier.example.com/v1', model: 'jev-latest', apiKey: 'classifier-private' },
};

for (const classifier of [null, config.classifier]) {
  test(`quoted credentials preserve structured input and output ${classifier ? 'with Jev' : 'without Jev'}`, async () => {
    let calls = 0;
    const result = await classify({
      summary: 'Fix configuration parsing', currentName: 'fix-config',
      newMessages: [{ text: `Fix config: password="dummy-review-value" secret='second-private-value'\n${config.apiKey}` }],
    }, { ...config, classifier }, async (url, options) => {
      calls++;
      const payload = JSON.parse(options.body);
      const state = url.endsWith('/systemone') ? payload.state : JSON.parse(payload.messages[1].content);
      assert.doesNotMatch(state.newMessages[0].text, /dummy-review-value|second-private-value|key-with/);
      assert.match(state.newMessages[0].text, /\[REDACTED\]/);
      if (url.endsWith('/systemone')) {
        return new Response(JSON.stringify({ answers: { task: {
          type: 'choice', choice: 'new_task', confidence: 1,
          probabilities: { new_task: 1, same_task: 0, uncertain: 0 },
        } } }));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        decision: 'new_task', summary: `Fix password="response-private-value" ${config.apiKey}`, name: 'fix-config',
      }) } }] }));
    });
    assert.equal(calls, classifier ? 2 : 1);
    assert.equal(result.name, 'fix-config');
    assert.doesNotMatch(result.summary, /response-private-value|key-with/);
    assert.match(result.summary, /\[REDACTED\]/);
  });
}
