# Sessions Desk

A local dashboard for people who run many [Claude Code](https://claude.com/claude-code) sessions at once on a
Windows machine. It lists every open session, shows which ones are working, waiting for you or finished, lets you
read their screen and conversation, and lets you answer them — from one browser tab, or from your phone.

![Sessions Desk: one session waiting on a permission dialog, one finished with its pull request, one at work](docs/demo.gif)

<sub>Recorded on the demo profile (`npm run demo`, made-up sessions).</sub>

> **Status: shared as-is.** This is a tool one team built for its own daily use and published in the hope it is
> useful. There is no support and no compatibility promise. Issues are welcome; they may not get an answer.
>
> Sessions Desk is an independent project. It is not affiliated with, endorsed by or supported by Anthropic.

## What it does

- **One list for all sessions** — status (working, waiting for an answer, done and unread), title, folder, git
  branch, pull request, model, token count. Notifications when a session finishes or waits.
- **Read** — the live terminal screen of a session, or its full conversation rendered from the transcript.
- **Answer** — type a reply, press a key, accept the suggested prompt, queue a message while the session works,
  send the same message to several sessions.
- **Slash commands** — type `/` in the reply box for the menu of the session’s commands (built-in, your skills and
  commands, the project’s, enabled plugins), with a warning for those that open a menu, cannot be undone or change
  a lasting setting. A mistyped command is refused instead of running its closest match.
- **Model for one session** — switch the model of a running session without touching the default for the next
  ones: the server drives the `/model` menu of the terminal and picks "this session only".
- **Terminal menus** — a menu left open in the terminal (`/mcp`, `/permissions`, `/config`…) is shown in the page
  with a key pad (arrows, Enter, Tab, Space, Backspace, Esc) and a text field, so it can be driven from a phone.
- **Start, fork, reopen, close** — new session in a folder or in a fresh git worktree, a fork of an existing
  session, reopen a closed one, close the ones whose work is merged.
- **Find** — full-text search across conversations, favourites, hide, tags.
- **Attach files** — drag and drop, paste or pick a file; the session receives its path.
- **From your phone** — read and answer over your own Tailscale network.

Optional modules, all off by default: an external orchestrator that launches headless sessions, Microsoft Teams
reply tracking, ticket references, an account usage banner, and the passes of your own scheduled scripts. See
[Optional modules](#optional-modules).

## Requirements

- Windows 11 with [Windows Terminal](https://aka.ms/terminal). Sessions must run in Windows Terminal tabs.
- Claude Code, installed and signed in.
- [Node.js](https://nodejs.org/) 22.18 or later (the server runs TypeScript sources directly).
- [.NET 10 SDK](https://dotnet.microsoft.com/download), to build the small Windows driver once.
- Optional: `git` and the GitHub CLI `gh` (branch and pull-request state), Tailscale (phone access).

macOS and Linux are not supported: reading a session's screen and typing into it rely on the Windows console API
and on Windows Terminal.

## Install

```powershell
git clone <this repository>
cd sessions-desk/server
npm ci
npm run build:driver          # builds the Windows driver into .build/driver
node src/main.ts --port 8765  # then open http://localhost:8765/
```

The server listens on the loopback interface only. Without `--port 8765` it starts on 8767 in read-only mode,
which is handy for a first look: it lists and reads sessions but refuses every action.

Optionally, let Claude Code tell the dashboard when a turn ends, so that "done" shows up immediately. Add this to
`~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "http", "url": "http://localhost:8765/api/hook", "timeout": 2 } ] } ] } }
```

## How it works

- **Server** (`server/`, Node.js, no runtime dependency) — reads `~/.claude` (session files, transcripts,
  history), serves the page and the JSON API.
- **Driver** (`driver/`, .NET) — a resident helper the server talks to over stdin/stdout. It attaches to a
  session's console to read its screen or type into it, focuses the right Windows Terminal tab, opens tabs and
  shows notifications.
- **Page** — plain JavaScript, no framework, no build step.

Sessions Desk does not use the Claude API and never sees your credentials. It drives the same terminal sessions
you would drive by hand.

It relies on behaviour Claude Code does not document — the layout of `~/.claude`, the transcript format, what the
terminal screen looks like. A Claude Code update can break it.

## Configuration

Everything specific to a machine lives in `~/.claude/sessions-desk/config.json` (another path: `--config <file>`
or the `SD_CONFIG` environment variable). The file is optional. A template is in `server/config.example.json`.

| Key | Purpose |
|---|---|
| `ui.pathPrefix` | Folder prefix not repeated in the list (for instance your main repository) |
| `ui.prUrl`, `ui.ticketUrl`, `ui.ticketLabel` | Where pull-request and ticket links point |
| `ui.models` | Relative cost of each model, so the page flags sessions on a pricier model: `[{ "match": "fable", "label": "Fable", "cost": 2, "note": "8 $ / 40 $" }, …]` — `match` is a piece of the model id (first match wins), `cost` a multiplier against the reference model (cost 1). Omitted: built-in table from public API prices (Opus = 1, Fable ×2, Sonnet ×0.5, Haiku ×0.025). When set, it replaces the built-in table. Entries with `"offer": false` are not offered in the new-session form (there, `match` is passed as is to `claude --model`). |
| `ui.quota` | Weekly quota thresholds in %: `{ "warn": 75, "alert": 90 }` (orange, then red + launcher alert) |
| `ui.shortcuts` | Buttons under the reply box that send a ready-made slash command in one click: `[{ "label": "Reconnect MCP", "command": "/mcp reconnect all", "confirm": "" }]`, 8 at most. Absent: two defaults (reconnect MCP servers, compact). Empty list: no button |
| `delays` | `{ "notifyAfterSeconds": 15, "notifyDoneAfterMinutes": 3, "closedDays": 14 }` — the command-line options of the same role win |
| `newSession.folders` | Folders always offered by the new-session form, even with no recent session there: `["~\\code\\my-repo"]`, 50 at most. Without it the form only offers folders where a session ran recently — and only offered folders can be launched in |
| `tailscaleExe` | Path to `tailscale.exe` (`""` turns remote access off); default: the standard install folder |
| `peers` | Your other machines whose sessions join this list: `["laptop"]` — see [Several machines](#several-machines) |
| `ui.language` | `en` or `fr`: the page language on this machine (default: the browser's) |
| `modules` | The optional modules below |

Paths may use `~`, `%USERPROFILE%`, `%LOCALAPPDATA%` and `%TEMP%`. A missing or malformed entry is ignored: the
server never fails to start because of this file.

### Several machines

If you run Sessions Desk on more than one machine of the same Tailscale account, one page can list them all. On each
machine, name the others by their tailnet machine name:

```json
{ "peers": ["laptop", "home-pc"] }
```

Each machine must run its own server on 8765 and be served on the tailnet (`tailscale serve --bg 8766`). The server
then reads the session list of its peers while a page is open, and relays a closed list of requests to them: read a
screen or a conversation, reply, answer a dialog, mark as seen. Sessions of another machine carry a 🖧 badge; type
`poste:laptop` in the search box (or click the badge) to show one machine only.

- Nothing is copied: transcripts, favourites and tags stay on the machine that runs the session.
- No new secret and no new port: a peer answers only its owner, identified by `tailscale serve`, exactly as for a
  browser. Closing, restarting or starting a session, and attaching a file, are not relayed — do them on that
  machine's own page.
- A machine that is off or asleep shows as one "unreachable" line; the rest of the list is unaffected.
- Keep the machines on close versions: a peer running an older server may not know a relayed route.

### Optional modules

| Module | What it turns on | Settings |
|---|---|---|
| `launcher` | A view of runs started by an external orchestrator (headless sessions), their files, alerts and orders | `root`: the orchestrator's data folder · `cli`: the command that receives orders · `ticketApi`: the command that reads a ticket · `cardsApi`: the command that lists and answers the question cards the orchestrator addresses to you (`pending`, `cards <ticket>`, `answer <ticket> <card> --answers-file <file>`, one JSON line each; it alone holds the ticket system's address and token) · `python` |
| `teams` | Sessions that wait for a Microsoft Teams reply or an Outlook email reply (opt-in `"mail": true`), with reminders; and a per-conversation view (💬) of all your active Teams chats — yours to answer, to look at, up to date — whether or not a session follows them, with full messages and an optional reply box that posts in your name on your click, and a way to hand a thread over to a session that then receives what follows (reply is opt-in `"reply": true`; the view itself is opt-in `"conversations": { "enabled": true }`) | `enabled`, plus the watcher's settings: `reminders`, `ownerName`, `mail`, `markRead`, `inbound` (`enabled`, `cwd`, `domains`), `export` (`command`, `ticketPattern`), `conversations` (`enabled`, `mute`, `reply`), `calendar` |
| `tickets` | The "current subject" of a session, from ticket references in your prompts | `pattern`: a regular expression |
| `quota` | An account usage banner: 5-hour window, week (all models) and week per model, with a projection to the weekly reset | `source`: `"usage-probe"` (built in, see below) · or `file`: a usage file written by a collector of your own |
| `automations` | Your scheduled scripts (cleanups, reports…): one group per script in the list, a card in the overview, the detail of a pass (summary, files, live conversation of its `claude -p` session), failure notifications and « run now » buttons | A list: `id`, `label`, `icon`, `history` (its JSONL history) · `runs` (folder of its passes) · `everyMinutes` · `cli` + `python` + `orders` (`id`, `label`, `args`, `confirm`) |

The `launcher` module is published as an example of plugging an orchestrator in; it expects that orchestrator's
own folder layout and is unlikely to fit yours unchanged.

The `automations` module reads one key per history line, written by your script:

```json
{"pass": {"v": 1, "status": "ok", "level": "ok", "summary": "3 folders cleaned · 4.2 GB freed", "startedAt": "2026-11-20T08:00:16Z",
          "minutes": 2.4, "runDir": "C:\\…\\runs\\20261120-080001", "sessionId": null, "costUsd": null,
          "files": ["report.md"], "quiet": false, "dryRun": false}}
```

`status` is `ok`, `nothing`, `dry-run`, `conflict`, `rejected` or `failed`; `level` (`ok`, `warn`, `error`) is the
health of the pass itself and drives notifications (every `error`, a second `warn` in a row); `quiet` passes get no
row, only a count in the group header; `files` are the only files of `runDir` the page may open, and `runDir` must be
under `runs`. A running `claude -p` whose command line cites a folder under `runs` is shown as the running pass.

### Account usage

With `"quota": { "source": "usage-probe" }`, the server measures the usage of the signed-in Claude account every
15 minutes by running Claude Code's own `/usage` screen without a model call:

```
claude -p /usage --output-format json --setting-sources project --strict-mcp-config --no-session-persistence
```

- **No token is read or used**: the probe never opens Claude Code's credentials and calls no Anthropic address
  itself. It costs nothing (0 turns, $0).
- It runs from an empty folder (`%LOCALAPPDATA%\sessions-desk\probe`) without your user settings, so none of your
  hooks fire and none of your MCP servers start (`--strict-mcp-config`); it leaves no transcript or history entry.
  It never appears in the session list.
- Only the subscription line and the `Current …` lines of the screen are kept; the rest (paths, skills, MCP
  servers) is discarded.
- If Claude Code ever answers with a model call instead (a version that would no longer know `/usage`), the probe
  stops until the server restarts.
- Several accounts on one profile (switching with `/login`): the signed-in account is measured, the others keep
  their last measure, shown with its age. After switching, "Restart sessions" puts every session on the new account.

### Tags

Tags are read from `~/.claude/state/session-tags/`. They are written by `server/src/tagger.ts`, a standalone
program meant to run as a scheduled task (`node server/src/tagger.ts`). Its rules are the `tagger` section of the
same `config.json` (see `server/config.example.json`):

| Key | What it does |
|---|---|
| `tagger.tools`, `tagger.topics` | `[{ "v": "<tag>", "re": ["<regex on the repo-relative path, lowercase, '/'>"] }]` — a file written or read by the session gives these tags (first matching tool only) |
| `tagger.domains` | Closed list of business domains (also the ones a ticket can carry) |
| `tagger.toolsWithoutTopic` | Tools whose files never give a domain (tooling) |
| `tagger.docs` | `docs/claude/<name>.md` → domain |
| `tagger.roots` | `[{ "re": "<regex whose group 1 is the repo-relative path>", "prefix": "" }]`, tried in order; default: Claude Code worktrees only |
| `tagger.worktrees` | Regexes whose group 1 is a worktree name (the "function" tag) |
| `tagger.deepDirs`, `tagger.genericWords`, `tagger.context` | Prefixes summarised 4 levels deep, words that never name a feature, one line describing the project for the small model |
| `tagger.llmModel`, `llmBatch`, `maxLlmBatchesPerPass`, `llmQuotaMaxPct`, `llmIdleMinutes` | Small model that suggests the function tag |

Ticket references use `modules.tickets.pattern`; the ticket domain comes from `modules.launcher.ticketApi`
(`python <script> ticket <id>`). Changing the section recomputes every tag (its fingerprint is the rules version).
An unreadable `config.json` stops the tagger with the reason, and the page shows it.

### Running it at logon

`server/watchdog/Install-NodeWatchdog.ps1 -Port 8765 -Primary` copies the current commit to a run folder and
registers a scheduled task that starts the server at logon and restarts it if it stops answering.
`server/scripts/restart-idle-sessions.ps1` is an optional helper that restarts idle sessions.
`server/watchdog/Deploy.ps1` does it all from a clean, pushed clone: it reinstalls the server and copies the tagger
and the Teams watcher to `~/.claude/scripts`, creating their scheduled tasks on first run.
When only `page/` changed since the running commit, it swaps the page files in place instead of restarting the
server: no downtime, and open pages reload themselves (`-Restart` forces a restart; decision and tests in
`server/watchdog/Deploy-Plan.ps1` and `deploy-plan-tests.ps1`).
Only one deployment runs at a time: a second one waits, then starts again from whatever the first one put in
service. A clone that is behind the running commit is refused (`-Rollback` to go back on purpose). The server is
first asked to stop cleanly (`/api/stop`: it finishes what it has received), and is killed only if it does not exit.
Each deployment is logged next to the watchdog's restarts in `%TEMP%\sessions-desk-node-watchdog.log` (hot page swap
or restart, clean or forced stop, length of the outage).
Two safeguards surround a restart. If preparing the new copy takes more than 20 s while a server is in service (a
sign the machine is overloaded), the deployment gives up before stopping anything (`-Force` to go ahead anyway).
If the new server has not answered after 90 s, it is stopped, the previous copy is put back and restarted, and the
deployment fails; the failed copy is kept in `node-<port>.failed`.

The server keeps its own performance trace in `%TEMP%\sessions-desk-node-<port>.perf.log` (moved to `.old` past
1 MB): one line per start with the time spent in each phase up to the first computed state (marked `LENT` past
5 s), and one line per event-loop stall longer than 2 s. Stalls are spotted from a worker thread, so a stall that
never ends is still logged. Each stall gives the phase the server was in and the CPU it used meanwhile: CPU close to
the stall's length means our code was computing; CPU close to zero means the process was waiting (disk,
antivirus, overloaded machine), not running our code.

## Keyboard shortcuts

`/` search · `n` next session that needs you · `r` reply · `p` take the suggested prompt · `h` screen /
conversation · `d` fork the selected session · `f` favourite · `x` close the session (or hide a closed one) ·
`c` copy the command that resumes it · `b` back · `t` board · `l` launcher view.

## Phone access

The server also listens on the next port (8766) for [`tailscale serve`](https://tailscale.com/kb/1312/serve):

```powershell
tailscale serve --bg http://localhost:8766
```

Use `serve`, which stays inside your own tailnet. **Never use `funnel`**, which would publish your sessions to
the internet.

## Security

Read this before you run it.

- **Single-user machines only.** There is no local authentication. Any process running on the machine can call
  the API and type into your sessions.
- **It can type into terminals.** Anything that can make the server send text to a session can run commands as
  you, within what that session is allowed to do.
- **With `peers` set, machines trust each other.** Whatever can call the local API of one machine can read and type
  into the sessions of your other machines through the relay. List only machines you would let do that.
- **Screens and transcripts contain secrets.** Whatever a session printed is readable through the dashboard.
- The server listens on loopback only, checks the `Origin` of every action, and serves remote requests only
  through `tailscale serve`.

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Development

```powershell
cd server
npm run typecheck
npm test          # builds the driver, then runs the tests against throw-away test consoles
```

### Try it without touching your sessions

```powershell
cd server
npm run build:driver   # once
npm run demo           # http://localhost:8851/ — Ctrl+C stops it and removes the demo folder
```

The demo runs the server on a throw-away profile with five made-up sessions (one waiting on a permission dialog,
one finished with a pull request, two at work, one idle) and a closed one to reopen or search for. Nothing of your
real `~/.claude` is read or written. `--root C:\some\empty\folder` puts the demo files there instead of the temp
folder, `--port` changes the port.

Tests never write to a real session: they open their own test consoles. Source comments and test names are in
French.

### Languages

The page is in English or French. It follows `?lang=en|fr` in the address, then the choice made with the button of
the overview, then `ui.language`, then the browser language. Every text shown to the user is written with both
versions side by side, `T('texte français', 'English text')`, in `page/app.js` and in `server/src/` (the server
answers in the language of the page, sent in the `X-SD-Lang` header of each call; see `server/src/i18n.ts`). A new
text needs both.

## License

[MIT](LICENSE).
