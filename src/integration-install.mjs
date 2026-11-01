import { access, lstat, stat, readFile, mkdir, realpath, rename, unlink, link, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, basename, join, delimiter, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import lockfile from 'proper-lockfile';

const AGENTS = ['pi', 'claude', 'codex', 'kimi'];
// Verified against the installed Claude/Codex schemas and Kimi HookEventType.
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const MANIFEST = 'integration-installation.json';
const BEGIN = '# BEGIN oh-my-herdr managed hooks';
const END = '# END oh-my-herdr managed hooks';
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = text => text === null ? null : createHash('sha256').update(text).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, message = code) {
  throw Object.assign(new Error(message), { safeCode: code });
}

function parseJSON(text) {
  let value;
  try { value = JSON.parse(text ?? '{}'); } catch { fail('invalid_json'); }
  if (!object(value)) fail('invalid_json');
  return value;
}

async function maybeStat(path, follow = false) {
  try { return await (follow ? stat(path) : lstat(path)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Resolve directory symlinks, but never follow a config file or wrapper symlink.
// Store this binding in the manifest so retargeting a directory is a conflict.
async function physicalPath(path) {
  const parent = dirname(path);
  try { return join(await realpath(parent), basename(path)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await physicalPath(parent), basename(path));
  }
}

async function snapshot(path, expectedPhysical) {
  const physical = await physicalPath(path);
  if (expectedPhysical && physical !== expectedPhysical) fail('path_changed');
  const info = await maybeStat(path);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) fail('unsafe_file');
  return { path, physical, text: info ? await readFile(path, 'utf8') : null, mode: info ? info.mode & 0o777 : undefined };
}

async function replaceFile(before, text) {
  await mkdir(dirname(before.path), { recursive: true, mode: 0o700 });
  const current = await snapshot(before.path, before.physical);
  if (current.text !== before.text) fail('concurrent_edit');
  if (text === null) {
    if (before.text !== null) await unlink(before.path);
    return;
  }
  const temporary = join(dirname(before.path), `.oh-my-herdr-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', before.mode ?? 0o600);
    try {
      await file.writeFile(text);
      await file.chmod(before.mode ?? 0o600);
      await file.sync();
    } finally { await file.close(); }
    const latest = await snapshot(before.path, before.physical);
    if (latest.text !== before.text) fail('concurrent_edit');
    if (before.text === null) await link(temporary, before.path);
    else await rename(temporary, before.path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function hookCommand(root, configHome, agent) {
  return ['env', `OH_MY_HERDR_HOME=${configHome}`, process.execPath, '--use-env-proxy',
    join(root, 'src/agent-hook.mjs'), agent].map(quote).join(' ');
}

function wrapper(root, configHome) {
  return '// Managed by oh-my-herdr.\n' +
    `import integration from ${JSON.stringify(pathToFileURL(join(root, 'integrations/pi.js')).href)};\n` +
    'export default function ohMyHerdr(pi) {\n' +
    `  return integration(pi, { ...process.env, OH_MY_HERDR_HOME: ${JSON.stringify(configHome)} });\n` +
    '}\n';
}

function stripJSONHooks(data, owner) {
  if (!object(data.hooks)) fail('managed_content_changed');
  // Validate the entire owned set before making any change. Extra hooks in the
  // same group are user-owned, while changes to our hook or matcher are conflicts.
  const locations = owner.events.map(event => {
    const groups = data.hooks[event];
    if (!Array.isArray(groups)) fail('managed_content_changed');
    const matches = [];
    groups.forEach((group, groupIndex) => {
      if (!object(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((hook, hookIndex) => {
        if (hook?.command === owner.command) matches.push({ group, groupIndex, hook, hookIndex });
      });
    });
    if (matches.length !== 1) fail('managed_content_changed');
    const found = matches[0];
    if (!isDeepStrictEqual(found.hook, { type: 'command', command: owner.command }) ||
        Object.keys(found.group).some(key => key !== 'hooks')) fail('managed_content_changed');
    return { event, ...found };
  });
  for (const { event, group, groupIndex, hookIndex } of locations) {
    group.hooks.splice(hookIndex, 1);
    if (group.hooks.length === 0) data.hooks[event].splice(groupIndex, 1);
    if (data.hooks[event].length === 0 && owner.createdEvents.includes(event)) delete data.hooks[event];
  }
  if (Object.keys(data.hooks).length === 0 && owner.createdHooks) delete data.hooks;
}

function jsonHooks(before, old, command, uninstall) {
  const data = parseJSON(before.text);
  if (old) stripJSONHooks(data, old);
  if (uninstall) return { text: old.createdFile && Object.keys(data).length === 0 ? null : json(data) };
  if (data.disableAllHooks === true) fail('hooks_disabled', 'Set disableAllHooks to false before installing hooks.');
  if (data.hooks !== undefined && !object(data.hooks)) fail('invalid_hooks');
  const owner = { kind: 'json', command, events: EVENTS, createdFile: old?.createdFile ?? before.text === null,
    createdHooks: data.hooks === undefined, createdEvents: EVENTS.filter(event => data.hooks?.[event] === undefined) };
  data.hooks ??= {};
  for (const event of EVENTS) {
    if (data.hooks[event] !== undefined && !Array.isArray(data.hooks[event])) fail('invalid_hooks');
    data.hooks[event] ??= [];
    if (data.hooks[event].some(group => group?.hooks?.some?.(hook => hook?.command === command))) fail('unmanaged_hooks');
    data.hooks[event].push({ hooks: [{ type: 'command', command }] });
  }
  return { text: json(data), owner };
}

function tomlHooks(before, old, command, uninstall) {
  let text = before.text ?? '';
  if (old) {
    if (text.split(old.block).length !== 2 || text.split(BEGIN).length !== 2 || text.split(END).length !== 2) {
      fail('managed_content_changed');
    }
    const suffix = text.slice(text.indexOf(old.block) + old.block.length);
    // A bare key after our final [[hooks]] belongs to that table. Removing the
    // block would silently move that user key into a different table.
    const next = suffix.split(/\r?\n/).find(line => line.trim() && !line.trimStart().startsWith('#'));
    if (next && (!next.trimStart().startsWith('[') || /^\[\[?\s*(?:hooks|"hooks"|'hooks')\s*\./.test(next.trimStart()))) {
      fail('managed_content_changed');
    }
    text = text.replace(old.block, '');
  }
  if (uninstall) return { text: old.createdFile && text === '' ? null : text };
  if (text.includes(BEGIN) || text.includes(END)) fail('unmanaged_hooks');
  let rootTable = true, hookArray = false;
  for (const line of tomlLines(text)) {
    if (/^\[\[\s*(?:hooks|"hooks"|'hooks')\s*\]\]$/.test(line)) hookArray = true;
    if ((rootTable && /^(?:hooks|"hooks"|'hooks')\s*=/.test(line)) ||
        (!hookArray && /^\[\s*(?:hooks|"hooks"|'hooks')\s*(?:\]|\.)/.test(line))) {
      fail('unsupported_hooks_layout', 'Use [[hooks]] records in Kimi config.toml before installing this integration.');
    }
    if (line.startsWith('[')) rootTable = false;
  }
  const block = '\n' + BEGIN + '\n' + EVENTS.map(event =>
    `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\n`).join('\n') + END + '\n';
  return { text: text + block, owner: { kind: 'toml', block, createdFile: old?.createdFile ?? before.text === null } };
}

// Mask comments and multiline strings so embedded config examples are not
// interpreted as settings. This is a lexical scan, not a full TOML parser.
function tomlLines(text) {
  let clean = '', multiline = null;
  for (let i = 0; i < text.length;) {
    if (multiline) {
      if (text.startsWith(multiline, i)) {
        i += 3;
        // TOML permits one or two quote characters immediately before the
        // closing delimiter; a run of four/five quotes closes the same string.
        for (let extra = 0; extra < 2 && text[i] === multiline[0]; extra++) i++;
        multiline = null; clean += '""';
      }
      else if (multiline === '"""' && text[i] === '\\') i += 2;
      else { if (text[i] === '\n') clean += '\n'; i++; }
    } else if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      multiline = text.slice(i, i + 3); i += 3;
    } else if (text[i] === '#') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text[i] === '"' || text[i] === "'") {
      const start = i++, q = text[start];
      let closed = false;
      while (i < text.length) {
        if (q === '"' && text[i] === '\\') { i += 2; continue; }
        if (text[i] === '\n') fail('invalid_toml');
        if (text[i++] === q) { closed = true; break; }
      }
      if (!closed) fail('invalid_toml');
      clean += text.slice(start, i);
    } else clean += text[i++];
  }
  if (multiline) fail('invalid_toml');
  return clean.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// Require an explicit feature switch. Unrecognized representations are reported,
// never rewritten or assumed enabled.
function codexHooksEnabled(text) {
  const key = name => `(?:${name}|"${name}"|'${name}')`;
  const featureTable = new RegExp(`^\\[\\s*${key('features')}\\s*\\]$`);
  const local = new RegExp(`^${key('hooks')}\\s*=\\s*(true|false)\\s*$`);
  const dotted = new RegExp(`^${key('features')}\\s*\\.\\s*${key('hooks')}\\s*=\\s*(true|false)\\s*$`);
  let section = '', enabled;
  for (const line of tomlLines(text)) {
    if (line.startsWith('[')) section = featureTable.test(line) ? 'features' : 'other';
    else {
      const match = (section === 'features' ? local : section === '' ? dotted : /$a/).exec(line);
      if (match) {
        if (enabled !== undefined) return undefined;
        enabled = match[1] === 'true';
      }
    }
  }
  return enabled;
}

async function legacyPackages(before, root, home) {
  const data = parseJSON(before.text);
  if (data.packages === undefined) return before.text;
  if (!Array.isArray(data.packages)) fail('invalid_packages');
  const target = await realpath(root);
  const packages = [];
  for (const entry of data.packages) {
    const source = typeof entry === 'string' ? entry : entry?.source;
    let candidate;
    if (typeof source === 'string') {
      if (source.startsWith('file:')) {
        try { candidate = fileURLToPath(source); } catch { /* Not a local file URL. */ }
      } else if (source.startsWith('~/')) candidate = resolve(home, source.slice(2));
      else if (!/^[a-z][a-z\d+.-]*:/i.test(source)) candidate = resolve(dirname(before.path), source);
    }
    let same = false;
    if (candidate) {
      try { same = await realpath(candidate) === target; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    if (!same) packages.push(entry);
  }
  if (packages.length === data.packages.length) return before.text;
  data.packages = packages;
  return json(data);
}

function matchesOwnership(before, owner) {
  if (!owner) return false;
  try {
    if (owner.kind === 'wrapper') return before.text === owner.content;
    if (owner.kind === 'json') jsonHooks(before, owner, null, true);
    else if (owner.kind === 'toml') tomlHooks(before, owner, null, true);
    else return false;
    return true;
  } catch { return false; }
}

async function installed(directory, executable, env) {
  if ((await maybeStat(directory, true))?.isDirectory()) return true;
  for (const part of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = resolve(part, executable);
    if (!(await maybeStat(path, true))?.isFile()) continue;
    try { await access(path, constants.X_OK); return true; }
    catch (error) { if (error.code !== 'EACCES') throw error; }
  }
  return false;
}

function errorOutcome(agent, error, partial = false) {
  // JSON parse errors and filesystem messages may include private config text.
  const code = error.safeCode ?? (/^E[A-Z]+$/.test(error.code ?? '') ? error.code : 'installation_failed');
  return { agent, status: 'error', code, partial,
    ...(error.safeCode && error.message !== code ? { message: error.message } : {}) };
}

/**
 * Install discovered agents. Returns [{agent, status, changed?, code?, message?, partial?}].
 * Status is installed/skipped/error; uninstall uses uninstalled/skipped/error.
 * Errors are isolated per agent; manifest/lock errors apply to all four agents.
 * Codex requires explicit features.hooks = true; missing/false is an actionable error.
 * No agent executable is launched. Environment overrides control discovery only;
 * hook commands inherit their runtime environment and pin OH_MY_HERDR_HOME.
 */
export async function installIntegrations(options) { return run(options, false); }

/** Uninstall by recorded ownership, even if executables or config overrides changed. */
export async function uninstallIntegrations(options) { return run(options, true); }

async function run({ root, home, configHome, env = process.env }, uninstall) {
  root = resolve(root); home = resolve(home); configHome = resolve(configHome);
  const manifestPath = join(configHome, MANIFEST);
  let release;
  try {
    const configInfo = await maybeStat(configHome);
    if (configInfo?.isSymbolicLink() || (configInfo && !configInfo.isDirectory())) fail('unsafe_file');
    if (uninstall && !configInfo) return AGENTS.map(agent => ({ agent, status: 'skipped', code: 'not_managed' }));
    await mkdir(configHome, { recursive: true, mode: 0o700 });
    release = await lockfile.lock(configHome, { realpath: true, retries: 0 });
    let manifestSnapshot = await snapshot(manifestPath);
    const manifest = manifestSnapshot.text === null ? { version: 1, agents: {} } : parseJSON(manifestSnapshot.text);
    if (manifest.version !== 1 || !object(manifest.agents)) fail('invalid_manifest');
    const save = async () => {
      const text = json(manifest);
      await replaceFile(manifestSnapshot, text);
      manifestSnapshot = await snapshot(manifestPath);
    };
    const directories = {
      pi: join(home, '.pi/agent'),
      claude: resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude')),
      codex: resolve(env.CODEX_HOME || join(home, '.codex')),
      kimi: resolve(env.KIMI_CODE_HOME || join(home, '.kimi-code')),
    };
    const results = [];
    for (const agent of AGENTS) {
      let changed = false;
      let record = manifest.agents[agent];
      try {
        if (record && (!Array.isArray(record.resources) || !record.resources.every(resource =>
          object(resource) && isAbsolute(resource.path) && isAbsolute(resource.physical) &&
          ['wrapper', 'json', 'toml'].includes(resource.kind)))) fail('invalid_manifest');
        if (record?.pending) {
          const pending = record.pending;
          const current = await snapshot(pending.path, pending.physical);
          const digest = hash(current.text);
          const previous = record.resources.find(resource => resource.path === pending.path);
          const matchesBefore = matchesOwnership(current, previous);
          const matchesAfter = matchesOwnership(current, pending.owner);
          if (digest === pending.afterHash || (matchesAfter && !matchesBefore)) {
            record.resources = record.resources.filter(resource => resource.path !== pending.path);
            if (pending.owner) record.resources.push(pending.owner);
          } else if (digest !== pending.beforeHash && !(matchesBefore && !matchesAfter)) {
            fail('pending_content_changed');
          }
          // Hashes identify completed/unapplied writes. Exact ownership also
          // allows unrelated user edits after interruption. Ambiguous changes
          // retain the journal; no private config backup is needed.
          delete record.pending;
          await save();
        }
        if (uninstall && !record?.resources.length) {
          results.push({ agent, status: 'skipped', code: 'not_managed' }); continue;
        }
        if (!uninstall && !record?.resources.length && !await installed(directories[agent], agent, env)) {
          results.push({ agent, status: 'skipped', code: 'not_installed' }); continue;
        }
        record ??= manifest.agents[agent] = { resources: [] };
        const apply = async (before, text, owner) => {
          if (text === before.text) return;
          const owned = owner ? { ...owner, path: before.path, physical: before.physical } : null;
          record.pending = { path: before.path, physical: before.physical,
            beforeHash: hash(before.text), afterHash: hash(text), owner: owned };
          await save();
          await replaceFile(before, text);
          changed = true;
          record.resources = record.resources.filter(resource => resource.path !== before.path);
          if (owned) record.resources.push(owned);
          delete record.pending;
          await save();
        };
        if (uninstall) {
          // Preflight all owned resources, so an edited wrapper or hook leaves
          // the agent intact. Other agents can still be removed independently.
          const plans = [];
          for (const owner of record.resources) {
            const before = await snapshot(owner.path, owner.physical);
            let text;
            if (owner.kind === 'wrapper') {
              if (before.text !== owner.content) fail('managed_content_changed');
              text = null;
            } else if (owner.kind === 'json') text = jsonHooks(before, owner, null, true).text;
            else text = tomlHooks(before, owner, null, true).text;
            plans.push({ before, text });
          }
          for (const { before, text } of plans) await apply(before, text, null);
          results.push({ agent, status: 'uninstalled', changed }); continue;
        }
        const path = join(directories[agent], agent === 'pi' ? 'extensions/oh-my-herdr.js' :
          agent === 'claude' ? 'settings.json' : agent === 'codex' ? 'hooks.json' : 'config.toml');
        const old = record.resources[0];
        if (old && old.path !== path) fail('config_path_changed', 'Uninstall the recorded integration before changing its config directory.');
        const before = await snapshot(path, old?.physical);
        let plan;
        if (agent === 'pi') {
          if (old ? before.text !== old.content : before.text !== null) fail(old ? 'managed_content_changed' : 'unmanaged_wrapper');
          const content = wrapper(root, configHome);
          plan = { text: content, owner: { kind: 'wrapper', content } };
          // Check migration before writing, then remove the legacy package only
          // after the wrapper has been durably installed and recorded.
          const settings = await snapshot(join(directories.pi, 'settings.json'));
          const migrated = await legacyPackages(settings, root, home);
          await apply(before, plan.text, plan.owner);
          await apply(settings, migrated, null);
        } else {
          if (process.platform === 'win32') {
            fail('unsupported_platform', 'Native Windows hooks for this agent are not supported yet. Pi and the interface can be installed independently.');
          }
          if (agent === 'codex') {
            const config = await snapshot(join(directories.codex, 'config.toml'));
            const enabled = codexHooksEnabled(config.text ?? '');
            if (enabled !== true) fail(enabled === false ? 'codex_hooks_disabled' : 'codex_hooks_not_enabled',
              'Set hooks = true in [features] in the Codex config.toml, then rerun installation.');
          }
          const command = hookCommand(root, configHome, agent);
          plan = agent === 'kimi' ? tomlHooks(before, old, command, false) : jsonHooks(before, old, command, false);
          // Avoid moving an unchanged managed group/block around user additions.
          if (old && (old.command === command || (old.kind === 'toml' && old.block === plan.owner.block))) {
            results.push({ agent, status: 'installed', changed: false }); continue;
          }
          await apply(before, plan.text, plan.owner);
        }
        results.push({ agent, status: 'installed', changed });
      } catch (error) {
        results.push(errorOutcome(agent, error, changed || Boolean(record?.pending) || Boolean(record?.resources.length)));
      }
    }
    return results;
  } catch (error) {
    return AGENTS.map(agent => errorOutcome(agent, error));
  } finally {
    if (release) await release();
  }
}
