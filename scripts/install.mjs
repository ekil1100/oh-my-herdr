import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.HERDR_APP_HOME || resolve(homedir(), '.config/herdr-app');
const configHome = process.env.OH_MY_HERDR_HOME || resolve(homedir(), '.config/oh-my-herdr');
const manifestPath = resolve(configHome, 'installation.json');
const app = (...args) => execFileSync('herdr-app', args, { encoding: 'utf8' });
const json = (...args) => JSON.parse(app(...args));
const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Installed Herdr mod changed; patch needs review: ' + before.slice(0, 70));
  return text.replace(before, after);
}

async function main() {
  if (process.argv.includes('--uninstall')) {
    const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
    app('do', 'layout.switch', '--name', saved.previousLayout);
    console.log('Original layout restored. Personal mods, labels and naming configuration are retained.');
    return;
  }
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const status = json('status');
  let manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
  const layoutName = 'oh-my-herdr';
  const agentsName = 'oh-my-herdr-agents';
  const paneName = 'oh-my-herdr-pane';
  // Compute every patch before mutating the user's installation.
  let agents = await readFile(resolve(home, 'mods/agents/main.js'), 'utf8');
  agents = 'import { terminalLabel } from "./labels.js";\n' + agents;
  agents = replaceOnce(agents,
    'return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";',
    'return terminalLabel(a.address, all.find(k => k.address === a.address), a.title || a.program?.name || "");');
  agents = replaceOnce(agents,
    'const name = full ? a.space_name || label(a) : more ?? (/^\\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));',
    'const name = label(a);');
  agents = replaceOnce(agents,
    '.child(div().flex_none().max_w(full && more ? 120 : 200).truncate()', '.child(div().flex_1().min_w(0).truncate()');
  agents = replaceOnce(agents,
    '.when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\\u00b7 ${more}`)))',
    '.tooltip(`${a.space_name} / ${a.tab_name} — ${name}`)');
  agents = replaceOnce(agents,
    '.child(k.name || k.template || k.program?.name || k.address)',
    '.child(terminalLabel(k.address, k, k.template || k.program?.name || ""))');
  agents = replaceOnce(agents, '.child(String(i + 1))', '.child(a.address)');
  let pane = await readFile(resolve(home, 'mods/pane/main.js'), 'utf8');
  pane = 'import { terminalLabel } from "./labels.js";\n' + pane;
  pane = replaceOnce(pane, 'panes, props, run, theme, home', 'panes, props, run, theme, home, terminals');
  pane = replaceOnce(pane,
    'const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";',
    'const name = terminalLabel(p.terminal, terminals().find(k => k.address === p.terminal), p.title || p.program?.name || "shell");');
  pane = replaceOnce(pane, '.child(name))', '.child(name).tooltip(name))');
  // Record ownership before cloning so a failed check can be retried safely.
  if (!manifest) {
    for (const target of [agentsName, paneName]) {
      if (existsSync(resolve(home, 'mods', target))) throw new Error(`Existing mod is not owned by this installation: ${target}`);
    }
    if (existsSync(resolve(home, 'layouts', layoutName + '.json'))) throw new Error('Existing oh-my-herdr layout is not owned by this installation.');
    manifest = { previousLayout: status.layout, layout: layoutName, mods: [agentsName, paneName] };
    await writeJSON(manifestPath, manifest);
  }
  // Clone performs the app's metadata and asset-prefix migration.
  for (const [source, target] of [['agents', agentsName], ['pane', paneName]]) {
    const folder = resolve(home, 'mods', target);
    if (!existsSync(folder)) app('do', 'mod.clone', JSON.stringify({ name: source, as: target }));
    else if (!manifest) throw new Error(`Existing mod is not owned by this installation: ${target}`);
  }
  for (const [source, target, code] of [['agents', agentsName, agents], ['pane', paneName, pane]]) {
    const folder = resolve(home, 'mods', target);
    await copyFile(resolve(root, 'ui/labels.js'), resolve(folder, 'labels.js'));
    await writeFile(resolve(folder, 'main.js'), code.replaceAll(`mods/${source}/`, `mods/${target}/`));
    console.log(app('check', folder).trim());
  }
  const layoutPath = resolve(home, 'layouts', layoutName + '.json');
  if (!existsSync(layoutPath)) app('do', 'layout.clone', JSON.stringify({ name: manifest.previousLayout, as: layoutName }));
  const layout = JSON.parse(await readFile(layoutPath, 'utf8'));
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.mod === 'agents') value.mod = agentsName;
    if (value.mod === 'pane') value.mod = paneName;
    for (const child of Object.values(value)) visit(child);
  }
  visit(layout);
  await writeJSON(layoutPath, layout);
  app('do', 'layout.switch', '--name', layoutName);
  console.log('Installed oh-my-herdr. Run npm run uninstall:app to restore the previous layout.');
  console.log(app('status'));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
