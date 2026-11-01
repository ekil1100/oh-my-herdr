# oh-my-herdr

Automatic task names and visible terminal IDs for Herdr App. Each agent keeps its own task label, including when multiple agents share a tab.

The Agents list and pane headers show `[t2] fix-login`. Names are stored in core's `auto-name.task` label. Space names, tab names, native terminal names, terminal titles, and unrelated labels remain under their existing owners. Remote terminal addresses retain their machine prefix.

## Installation

Requires Herdr App with `herdr-app` and `hc` in PATH, and Node.js 22.21+ within Node 22 or 24.5+. The app must be running to install the interface.

macOS / Linux:

```sh
./install.sh
```

Windows (PowerShell):

```powershell
.\install.ps1
```

If PowerShell blocks local scripts, use a process-scoped invocation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The Windows entry point uses `npm.cmd` and preserves your current directory. Native Windows hooks for Claude Code, Codex, and Kimi are not supported yet: the installer reports these agents as errors instead of writing POSIX hook commands. The interface and Pi integration are still installed. Windows execution has not yet been verified on a Windows host.

The one-command installer checks the required commands and running app, installs locked npm dependencies, creates the default naming configuration if missing, and installs the interface and discovered agent integrations. Run it again to update; existing naming configuration is preserved. Keep this checkout in a permanent location because installed integrations reference its files.

The script reports any remaining configuration or credential requirements. Set `DEEPSEEK_API_KEY` in the environment that launches your agents for the default configuration, or configure another provider as described below. It does not install Node.js or Herdr itself.

The installer manages Pi, Claude Code, Codex, and Kimi integrations for agents found on this machine. It installs Pi's adapter in the auto-loaded extensions directory and registers native hooks for the other agents. An existing Pi package entry for this repository is migrated automatically. No separate `pi install` command is needed.

Run `/reload` in existing Pi sessions and restart other existing agents after installation. New sessions load their integration automatically. Each integration reports the exact session to `$HC_TERMINAL_ID` and checks task changes asynchronously. Integrations stay inactive outside an hc terminal.

Codex requires `hooks = true` in its `[features]` configuration. The installer reports disabled hooks or edited managed files explicitly and preserves unrelated configuration. To install or update only agent integrations, use `npm run install:agents`.

The interface installer clones the installed `agents` and `pane` mods, patches the copies, checks both, and activates an `OhMyHerdr` copy of your current layout with a dedicated preview image. The current layout must use the standard `agents` and `pane` mods. Original mods remain unchanged. Re-running the installer refreshes the managed copies from the installed upstream mods; custom edits to those copies are replaced. If upstream code changes incompatibly, installation stops for review.

To return to the original interface:

```sh
npm run uninstall:app
```

This switches back to the saved layout and removes the managed agent integrations. It keeps task labels, personal mod files, naming configuration, and unrelated hooks. Reload or restart existing agents to unload their integrations. To remove only the agent integrations, use `npm run uninstall:agents`. Stop any separately launched `watch` process as well.

## Configuration

The installer creates `~/.config/oh-my-herdr/config.json` from `config.example.json` when missing. Edit it to select your provider and model:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash"
}
```

Set `DEEPSEEK_API_KEY` in the environment that launches your agents. OpenAI is also supported with `"provider": "openai"`, a model, and `OPENAI_API_KEY`. An optional `baseUrl` selects an API gateway. Optional TypeSafe Jev classification uses `classifier` and `TYPESAFE_API_KEY`; see [backend configuration](integrations/README.md#configuration).

Task text and summaries are sent to the configured naming service and optional classifier. Credentials stay in environment variables. Existing provider configuration from `herdr-auto-name` is compatible; the installer does not copy credentials or choose a provider.

`OH_MY_HERDR_HOME` overrides the configuration/state directory and is recorded in the installed adapters. `HERDR_APP_HOME` selects the app installation. Agent hooks enable Node's environment proxy support (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`). When running the CLI yourself, use `node --use-env-proxy` if needed.

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

### Agent support

| Agent | Managed integration | Session source |
| --- | --- | --- |
| Pi 1.4.0 | Auto-loaded extension | Exact path from the interactive session manager |
| Claude Code | Native lifecycle hooks | Session ID and transcript path from the hook payload |
| Codex 0.159.0 | Native lifecycle hooks | Session ID and transcript path from the hook payload |
| Kimi Code 2.3.3 | Native lifecycle hooks | Exact session ID, validated against local state and wire history |

The installer respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `KIMI_CODE_HOME`. Run the naming backend on the machine holding the transcript; the GUI can display remote labels. Kimi automatic binding uses the current `.kimi-code` layout; older `context.jsonl` files remain readable through manual binding.

Codex can switch between already loaded threads without emitting a lifecycle hook. Its binding then follows the next valid session-start or user-submit hook; a view-only switch may leave the previous task name visible. Pi RPC/print child sessions and hook payloads identified as subagents do not replace the terminal's binding.

Manual binding remains available for diagnostics:

```sh
node src/main.mjs bind t7 claude /absolute/path/to/session.jsonl
node src/main.mjs bind t8 codex /absolute/path/to/rollout.jsonl
node --use-env-proxy src/main.mjs watch --interval 15
```

Managed integrations trigger checks themselves. Optional `watch` retries bound live terminals; it does not select sessions by directory or modification time.

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
