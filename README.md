# oh-my-herdr

Automatic task names and visible terminal IDs for Herdr App. Each agent keeps its own task label, including when multiple agents share a tab.

The Agents list and pane headers show `[t2] fix-login`. Names are stored in core's `auto-name.task` label. Space names, tab names, native terminal names, terminal titles, and unrelated labels remain under their existing owners. Remote terminal addresses retain their machine prefix.

## Installation

Requires Herdr App with `herdr-app` and `hc` in PATH, and Node.js 22.21+ within Node 22 or 24.5+. The app must be running to install the interface.

```sh
npm ci
npm run install:app
pi install /absolute/path/to/oh-my-herdr
```

Run `/reload` in existing Pi sessions after installation. New Pi sessions load the extension automatically. The extension binds the exact Pi transcript to `$HC_TERMINAL_ID` and checks task changes asynchronously. It has no effect outside an hc terminal.

The interface installer clones the installed `agents` and `pane` mods, patches the copies, checks both, and activates an `oh-my-herdr` copy of your current layout. The current layout must use the standard `agents` and `pane` mods. Original mods remain unchanged. Re-running the installer refreshes the managed copies from the installed upstream mods; custom edits to those copies are replaced. If upstream code changes incompatibly, installation stops for review.

To return to the original interface:

```sh
npm run uninstall:app
```

This switches back to the saved layout; it keeps task labels, personal mod files, and naming configuration. To also stop Pi hooks, run `pi remove /absolute/path/to/oh-my-herdr` and `/reload`. Stop any separately launched `watch` process as well.

## Configuration

Create `~/.config/oh-my-herdr/config.json` from `config.example.json`:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash"
}
```

Set `DEEPSEEK_API_KEY` in the environment that launches Pi. OpenAI is also supported with `"provider": "openai"`, a model, and `OPENAI_API_KEY`. An optional `baseUrl` selects an API gateway. Optional TypeSafe Jev classification uses `classifier` and `TYPESAFE_API_KEY`; see [backend configuration](integrations/README.md#configuration).

Task text and summaries are sent to the configured naming service and optional classifier. Credentials stay in environment variables. Existing provider configuration from `herdr-auto-name` is compatible; the installer does not copy credentials or choose a provider.

`OH_MY_HERDR_HOME` overrides the configuration/state directory. `HERDR_APP_HOME` selects the app installation. Pi hooks enable Node's environment proxy support (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`). When running the CLI yourself, use `node --use-env-proxy` if needed.

### Naming controls

From this repository:

```sh
node src/main.mjs rename                  # Generate a name for this terminal
node src/main.mjs pause                   # Pause this binding
node src/main.mjs resume                  # Resume and regenerate
node src/main.mjs check t2                # Process changed conversation text
hc label t2 auto-name.task="Review auth" # Manual display name
```

A manual label change pauses automatic naming after it has observed the previous value. Use `resume` to hand control back. Automatic names are short English task slugs; manually supplied display names may use any language. Same-task follow-ups retain the name. Missing text or provider errors keep the current label.

### Other agents

Claude Code, Codex, and Kimi use explicit local transcript binding:

```sh
node src/main.mjs bind t15 kimi /absolute/path/to/context.jsonl
node src/main.mjs bind t7 claude /absolute/path/to/session.jsonl
node src/main.mjs bind t8 codex /absolute/path/to/rollout.jsonl
node --use-env-proxy src/main.mjs watch --interval 15
```

Run watch in a dedicated terminal. It checks only explicitly bound live terminals; it never picks a session by directory or modification time. Rebind after switching sessions. Pi hooks handle their own checks and do not require watch. Automatic discovery of non-Pi sessions is not included in this version. Run the naming backend on the machine holding the transcript; the GUI can display remote labels.

### Display rules

Both custom mods use the same helper: task label → native terminal name → terminal title → program name. Terminal addresses always appear, including for shells and child agents. Long names truncate with a full-name tooltip. Native focus, status, split, zoom, close, pin, and grouping controls are preserved. Labels are not CLI aliases: address the terminal with `t2`, not its task text.

## Validation

```sh
npm test
herdr-app check ~/.config/herdr-app/mods/oh-my-herdr-agents
herdr-app check ~/.config/herdr-app/mods/oh-my-herdr-pane
herdr-app status
herdr-app shot /tmp/oh-my-herdr.png
```

Tests cover session readers, stale results, session binding generations, queue/control ordering, manual overrides, label preservation, Pi lifecycle hooks, provider handling, and display identity. See [integration details and limitations](integrations/README.md).

Naming code is adapted from Herdr Auto Name under the included MIT license. Interface code is generated locally from your installed Herdr mods; this repository supplies the patches and shared label helper.
