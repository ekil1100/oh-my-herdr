# Naming backend integration

The backend updates `auto-name.task` on an hc terminal. It preserves the terminal's native name and all unrelated labels, including `herdr.space` and `herdr.tab`. It uses only `hc get`, `hc ls`, and `hc label`.

## Installation

The package declares `proper-lockfile` version `4.1.2`, ES modules, and Node `^22.21.0 || >=24.5.0`. The Node requirement includes support for compressed Codex transcripts. Source and regression tests were adapted from `herdr-auto-name` under the included MIT license.

From the project root:

```sh
cd /absolute/path/to/oh-my-herdr
npm install
node src/main.mjs --help
node --test test/*.test.mjs
```

Load the Pi extension for one invocation:

```sh
pi --extension /absolute/path/to/oh-my-herdr/integrations/pi.js
```

For persistent installation, merge this entry into the existing `extensions` array in `~/.pi/agent/settings.json`, then run `/reload` in Pi:

```json
{
  "extensions": ["/absolute/path/to/oh-my-herdr/integrations/pi.js"]
}
```

The package declares its Pi extension, so the recommended persistent installation is:

```sh
pi install /absolute/path/to/oh-my-herdr
```

Use one installation method. Keep the entry point beside this package's `src/` directory; copying `pi.js` alone breaks its relative import.

## Configuration

The default home is `~/.config/oh-my-herdr`. `OH_MY_HERDR_HOME` overrides the entire home, including `config.json` and `state/`. State files are mode `0600`; directories created by the backend are mode `0700`. Queues are scoped by `HC_SESSION` when set, and individual session state is scoped by binding generation.

The existing provider contract is unchanged:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash"
}
```

Supported naming providers are `deepseek` and `openai`, with optional `baseUrl`. Credentials come from `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` in the launching process's environment. Optional task classification uses:

```json
{
  "provider": "openai",
  "model": "YOUR_NAMING_MODEL",
  "classifier": {
    "provider": "typesafe",
    "model": "jev-latest"
  }
}
```

The classifier reads `TYPESAFE_API_KEY`. It can also specify `baseUrl`. URLs require HTTPS except for loopback HTTP. Custom `apiKeyEnv` fields remain unsupported. The extension inherits Pi's environment; watch inherits its launching shell's environment. Provider configuration is read only when a new text snapshot needs classification. Bind, pause, cached checks, and unbound checks require no API credentials. Errors contain safe codes, never provider response bodies or credentials.

## Commands and hooks

Run these commands from the package root:

```sh
node src/main.mjs bind t7 pi /absolute/path/to/session.jsonl
node src/main.mjs bind t7 claude /absolute/path/to/claude-session.jsonl
node src/main.mjs bind t7 codex /absolute/path/to/rollout.jsonl.zst
node src/main.mjs bind t7 kimi /absolute/path/to/session-id/context.jsonl
node src/main.mjs check t7
node src/main.mjs rename t7
node src/main.mjs pause t7
node src/main.mjs resume t7
node src/main.mjs unbind t7
node src/main.mjs watch --interval 15
```

For `check`, `rename`, `pause`, `resume`, and `unbind`, omitting the terminal uses `HC_TERMINAL_ID`. An hc terminal name is resolved to its address before requests are queued. `bind` always requires its terminal, agent, and absolute session file path. It does not require the session file to exist yet. No session directory is searched and no session is selected by cwd or modification time.

Binding labels are:

| Label | Value |
| --- | --- |
| `auto-name.agent` | `pi`, `claude`, `codex`, or `kimi` |
| `auto-name.session` | Exact absolute transcript path |
| `auto-name.binding` | Opaque UUID identifying this binding generation |
| `auto-name.task` | Generated task slug or manual task text |

Repeated binding to the same agent and path preserves the token and pause state. A changed binding gets a new token, which rejects older queued or in-flight results even after switching away and back. Bind and final task writes share a short per-terminal lock. Unbind removes only the three binding labels and preserves the task label.

`rename` requests one generated name, including while paused. `resume` clears pause and requests a fresh name. A manual change to `auto-name.task` after the backend has observed it causes an automatic pause. Controls and pending model results survive process restarts. A new binding starts independent progress and may replace an existing task label on its first classification. To keep a manual title on that new binding, pause before checking it.

Pi 1.4.0 exposes session replacement through `session_start` with reason `new`, `resume`, or `fork`; it has no separate `session_switch` event. The extension:

- Binds `ctx.sessionManager.getSessionFile()` on every `session_start`.
- Invalidates the old binding in `session_shutdown` for new/resume/fork. Reload and quit retain the binding and pause state.
- Schedules checks on user/text assistant `message_end`, `agent_start`, `agent_end`, `agent_settled`, and `session_tree`.
- Runs checks asynchronously with a 100 ms debounce and one active check per extension runtime. A follow-up runs if another event arrives during a check.
- Ignores tool-result and tool-call-only messages. Content-derived snapshot revisions also prevent provider calls on tool-only and metadata updates.
- Uses `check <terminal> --session <absolute-path>` to reject late hooks from another session. The same guard is available for `unbind`.

Pi hooks are sufficient for ordinary Pi use. Use `watch` for explicitly bound Claude, Codex, or Kimi sessions, or as a retry mechanism. Watch scans live terminals, queues only supported explicit bindings, and waits 15 seconds after each pass. Accepted intervals are 5–300 seconds. SIGINT/SIGTERM stop it after the current bounded operation. It does not start agents or a service.

CLI output is JSON lines. Expected statuses include `bound`, `unbound`, `renamed`, `unchanged`, `same_task`, `uncertain`, `no_text`, `paused`, `external_name_paused`, `superseded`, `stale_result`, and `pending`. Invalid invocation/setup exits nonzero. A queued processing failure reports `pending` with a safe error code and retains its request for a later check or watch pass; callers should inspect that status even when the process exits zero.

## Validation and limits

Tests cover the real Node CLI against a fake hc executable and a local HTTP provider, binding changes during provider latency, binding generations, control ordering, manual overrides, label preservation, pending-write recovery, tool-only snapshot caching, Pi hook ordering and coalescing, provider contracts and redaction, and Pi/Claude/Codex/Kimi transcript readers. The installed Pi extension loader also loaded `integrations/pi.js` successfully without installing it.

The backend reads local transcript files only. Run it on the machine hosting the agent and transcript. The reader bounds files and decompressed content to 32 MiB and reads complete JSONL records only. Pi must persist a version 3 transcript; `--no-session` has no file to bind. Pi's reader follows the last persisted entry's parent chain: pure `/tree` navigation without a subsequent persisted entry is not observable from the transcript alone.

The worker processes provider requests serially and gives each provider HTTP request a 15-second timeout. Multiple hooks share the durable queue; provider outages are retried only by later checks or watch passes. A single pass visits at most 128 requests. Binding changes and controls invalidate stale results; hc does not offer a conditional label update, so an external manual `hc label` command in the very small interval between the last read and write cannot be made atomic with this backend. Two terminals explicitly bound to the same agent/session path are refused as ambiguous by the reused engine. Reload retains pause; changing the binding creates independent pause state.

Live validation additionally confirmed a provider-generated task label and its rendering in the installed Agents list and pane header. Existing Pi sessions must reload once to activate newly installed hooks.
