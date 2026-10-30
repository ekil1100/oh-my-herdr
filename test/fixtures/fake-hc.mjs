#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises';
const path = process.env.FAKE_HC_STATE;
const terminals = JSON.parse(await readFile(path, 'utf8'));
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const [command, target, ...values] = args;
const terminal = terminals.find((item) => item.address === target || item.name === target);
let result;
if (command === 'ls') result = { terminals: terminals.filter((t) => t.state === 'live').map(({ address }) => ({ address })) };
else if (command === 'get' && terminal) result = terminal;
else if (command === 'label' && terminal) {
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator < 0) throw new Error('missing label value');
    const key = value.slice(0, separator), content = value.slice(separator + 1);
    if (content) terminal.labels[key] = content;
    else delete terminal.labels[key];
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(terminals));
  await rename(temporary, path);
  result = terminal;
} else throw new Error('unsupported fake hc invocation');
console.log(JSON.stringify(result));
