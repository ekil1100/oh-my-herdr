import test from 'node:test';
import assert from 'node:assert/strict';
import { taskName, terminalLabel } from '../ui/labels.js';

test('task metadata wins without changing the terminal identity', () => {
  const terminal = { name: 'worker', title: 'Pi', labels: { 'auto-name.task': 'fix-login' } };
  assert.equal(terminalLabel('t2', terminal), '[t2] fix-login');
  assert.equal(terminal.name, 'worker');
});
test('two terminals in one tab keep distinct task labels', () => {
  assert.equal(terminalLabel('t2', { labels: { 'auto-name.task': 'build' } }), '[t2] build');
  assert.equal(terminalLabel('t15', { labels: { 'auto-name.task': 'review' } }), '[t15] review');
});
test('remote addresses remain qualified and unnamed terminals use their title', () => {
  assert.equal(terminalLabel('vps/t2', { title: 'zsh' }), '[vps/t2] zsh');
  assert.equal(taskName({ name: 'reviewer', title: 'Pi' }), 'reviewer');
  assert.equal(terminalLabel('t3', null, 'shell'), '[t3] shell');
});
test('mod panes have no synthetic terminal ID', () => {
  assert.equal(terminalLabel(null, null, 'Files'), 'Files');
});
