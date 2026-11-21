# Architecture

For anyone changing the code — people and coding agents alike. The README says what the tool does and how to run
it; this file says how the code is laid out, how the parts talk, and where the traps are. Read `CLAUDE.md` first for
the publication rules.

## The three parts

```
 browser page (page/)  ──HTTP──▶  Node server (server/src/)  ──JSON lines on stdin/stdout──▶  driver (driver/, .NET)
   polls /api/state every 2 s        reads ~/.claude, serves the API                          attaches to consoles,
                                     ▲                                                         Windows Terminal, toasts
              Claude Code Stop hook ─┘ POST /api/hook
```

- **Server** — Node.js 22.18+, TypeScript run directly (type stripping, no build), **no runtime dependency**. Keep it
  that way: `package.json` has dev dependencies only (typescript, vitest).
- **Driver** — a resident .NET 10 process started by the server. Everything that needs the Win32 console API or
  Windows Terminal lives there, and nothing else.
- **Page** — `page/index.html`, `app.js`, `app.css`. Plain JavaScript, no framework, no build step, no module system:
  one script whose functions are globals.

## Server modules (`server/src/`)

Every file starts with a comment that states its role; read it before changing the file.

| Area | Files | Role |
|---|---|---|
| Entry, settings | `main.ts`, `config.ts`, `modules.ts`, `schema.ts` + `config.schema.json`, `config-edit.ts` | Command line, `config.json` (load, hot reload, schema, edit from the page) |
| HTTP | `http.ts` | Routing, access rules, the request queue (see below) |
| Session state | `state.ts` (`Dashboard`) | The session list: reads `~/.claude`, computes the status of each session, favourites, hidden, seen |
| Background loop | `watch.ts` | Every 2 s, page open or not: notifications, "seen" from the foreground tab, git and PR refresh, module alerts |
| Actions | `actions.ts`, `commands.ts`, `prompt.ts`, `queued.ts`, `parked.ts`, `drafts.ts` | Send, keys, focus, close, relaunch, new session; the `/` menu and its guard; what sits in a session's prompt |
| Reading | `transcript.ts`, `search.ts`, `image.ts`, `upload.ts`, `quiet.ts`, `asks-judge.ts` | Conversation view, full-text index, image preview, attachments, "nothing new" turns, the "waits for the user?" judge |
| Git | `gitpr.ts` | Branch, dirty files, pull-request state (`gh`), cached outside requests |
| Driver client | `driver.ts` | Starts, times out, kills and restarts the driver |
| Remote | `relay.ts`, `peers.ts` | `tailscale serve` relay health and identity; other machines of the same owner |
| Modules | `launcher.ts`, `cards.ts`, `run-live.ts`, `teams-watcher.ts`, `teams-kick.ts`, `usage.ts`, `usage-probe.ts`, `usage-parse.ts`, `automations.ts` | Optional modules, off unless `config.json` names them |
| Standalone programs | `tagger.ts`, `teams-watcher.ts` | Also run as scheduled tasks (`node server/src/tagger.ts`), outside the server process |
| Shared | `util.ts`, `i18n.ts`, `stall.ts` | Helpers, server-side French/English, performance trace |

`server/scripts/`: `demo.ts` (demo profile), `check-config.ts`, `guard.mjs` (CI guard), `focus-session.ps1`,
`restart-idle-sessions.ps1`. `server/watchdog/`: install, deploy and auto-update scripts (PowerShell), with their own
tests (`deploy-plan-tests.ps1`, `watchdog-tests.ps1`).

## Where a session's status comes from

1. **Open sessions** are the files `~/.claude/sessions/<pid>.json` that Claude Code writes, kept only if a `claude`
   process with that pid is alive (driver op `procs`). The file gives `sessionId`, `cwd`, `status`
   (`busy`, `idle`, `shell`…), `statusUpdatedAt`, `waitingFor`.
2. **Metadata** (title, model, tokens, PR, last reply) is read from the transcript under `~/.claude/projects/`.
3. **Stale "busy" fix** (`Dashboard.busyFix`): Claude Code sometimes leaves `busy` after a turn ended. If the Stop
   hook arrived after the last status change, or the status is older than 30 s, the server reads the screen; no
   `esc to interrupt` / spinner line on it ⇒ the session is shown idle. Each fix is logged in
   `~/.claude/state/sessions-dashboard-stale.jsonl`.
4. **Spinner** (`screenSpin`) — the verb and token count of the turn, read from the same screen read.
5. **Done / unread** — idle, and the last turn that counts (`quiet.ts` skips turns with nothing new) is newer than
   the "seen" mark.
6. **Waits for the user?** — `asks-judge.ts` asks a small model (Haiku by default, `SD_ASK_MODEL`) whether the last
   message asks something of the user. Writable server only, at most 2 calls at a time, cached on disk; the page
   falls back to its own heuristic `asks()` until the verdict is there.
7. **Dialogs and menus** — read from the screen by the driver (`read`, `suggestion`) and parsed in the page.

All of this relies on undocumented Claude Code behaviour (file layout, transcript format, screen text). When a
Claude Code update breaks the list, look here first.

## The HTTP server (`http.ts`)

- **Two paths.** The *front* answers at once from snapshots: the page files, `/api/ping`, `/api/state` and
  `/api/closed` (recomputed every second / 15 s), `/api/screen`, `/api/transcript`, `/api/image`, `/api/upload`,
  `/api/hook`. **Everything else goes through a queue handled one request at a time**, between two state computations,
  never during one. A slow handler there delays every action: keep it short or detach it.
- **Route sets at the top of the file** decide access. When you add a route, decide for each set:
  - `ACTIONS` — writes; refused unless the server runs with write allowed (port 8765, `--primary` or `--allow-write`).
  - `REMOTE_OK` — read routes allowed through the tailnet relay. Anything not listed is refused remotely, except
    POSTs from the owner's own remote origin.
  - `REMOTE_NEVER` — never through the relay, even for the owner (stop, hook, config edit…).
  - `HEADLESS_REFUSED` — actions that make no sense on a `claude -p` run with no terminal.
  - `LAUNCHER_ROUTES`, `TEAMS_ROUTES`, `AUTOMATION_ROUTES` — 404 when the module is off.
  - `PEER_GET` / `PEER_POST` in `peers.ts` — the closed list relayed to other machines.
- Every action checks the `Origin`; `Sec-Fetch-Site: cross-site|same-site` is refused. `server/test/security.test.ts`
  covers the access matrix: extend it with the route.
- The page sends its language in `X-SD-Lang`; server messages use `T('fr', 'en')` from `i18n.ts`.

## The driver (`driver/`)

- Protocol: one JSON request per line on stdin `{"id":1,"op":"read","args":{"pid":1234}}`, one answer per line on
  stdout `{"id":1,"ok":true,"result":…}` or `{"id":1,"ok":false,"error":"…"}`, **in the order they finish**.
- Operations (`driver/src/Ops.cs`, typed in `DriverOps` of `driver.ts`): `ping`, `title`, `foregroundTitle`,
  `idleSeconds`, `read`, `suggestion`, `send`, `sendKeys`, `focus`, `wt`, `toast`, `procs`. `test.*` operations
  exist only when the driver runs in test mode.
- A process can attach to **one console at a time**: every console operation takes `ConScreen.Gate`. That is why the
  tests run one file at a time (`fileParallelism: false`).
- Each operation has a timeout in `DEFAULT_TIMEOUTS`. Past it the driver is considered frozen (a dead Windows
  session can freeze user32), killed, and restarted at the next request: the server never hangs on it.
- stdin closed ⇒ the driver exits. Adding an operation means: `Ops.cs`, `DriverOps`, a timeout, a test in
  `driver-protocol.test.ts` or `driver-console.test.ts`.
- `--fake-console` turns the driver into a **test console**: a fake session the tests type into and read from.

## Ports and instances

| Port | Role |
|---|---|
| 8765 | Main server: write allowed, notifications, background tasks, state files without suffix |
| 8766 | Its relay for `tailscale serve` (always main port + 1) |
| 8767 | Default when `--port` is omitted: read-only, no notification, state files suffixed `-8767` |
| 8768 | Relay of 8767 |
| 8831–8834 | Integration tests, `parity/harness.ts` (`SD_PARITY_PORT` changes the base) |
| 8851 | `npm run demo` |

Never start anything on 8765–8768 from a test or an experiment: those ports are a real machine's sessions.
The read-only 8767 role is a leftover of the migration from the historical server (see below) and stays useful as
a safe first look.

## Files written outside the repository

- `~/.claude/state/` — server state: `sessions-dashboard-seen.json`, `-favs.json`, `-hidden.json`, `-notifs.jsonl`,
  `-status*.jsonl`, `-stale.jsonl`, `sessions-new-drafts.json`, `sessions-ask-verdicts.json`, and
  `session-tags/` (written by the tagger). Suffixed `-<port>` off 8765.
- `~/.claude/sessions-desk/config.json` — the machine's settings (read, watched, edited from the page with backups).
- `%TEMP%\sessions-desk-node-<port>.perf.log`, `%TEMP%\sessions-desk-node-watchdog.log` — performance and deploy logs.
- `%LOCALAPPDATA%\sessions-desk\` — deployed copy `node-<port>` (previous one in `.previous`), usage probe folder,
  auto-update decision.

## Settings (`config.json`)

- Loaded by `loadSettings` (`modules.ts`); a missing or malformed entry is ignored, never fatal. The file is checked
  against `config.schema.json` (`schema.ts`) and every mismatch is listed in the page (`configWarnings`): a key missing
  from the schema shows up as a warning on every machine that sets it.
- `config-schema.test.ts` checks the schema itself and that `server/config.example.json` passes it.
- Hot reload: `watchConfig` / `reloadConfig` in `config.ts`. Keys listed by `restartKeys` need a restart and the page
  says so; the rest applies within a second. Command-line options keep precedence.
- `PROTECTED` in `config-edit.ts`: keys that run a program or widen access. The page editor refuses to change them.
  A new key that runs a program or names a folder to launch in belongs there.
- Also update `server/config.example.json` and the README table.

## Adding a…

- **Setting** — `modules.ts` (load + warning), `config.schema.json`, restart or hot (`restartKeys`), `PROTECTED` if it
  runs something, `config.example.json`, README.
- **Optional module** — off by default; its routes in a `*_ROUTES` set (404 when off); its view in `modulesView`
  (`modules.ts`) so the page knows it is on; nothing about it in the core when it is off. A team-specific integration
  is always a module, never core code.
- **Route** — the route sets above, a handler on the right path (front or queue), a test in `security.test.ts` for
  access, both languages for every message.
- **Page text** — always `T('texte français', 'English text')`.

## Tests (`server/test/`)

- `npm test` builds the driver once (`global-setup.ts`; `SD_DRIVER_EXE` uses a prebuilt one), then runs vitest,
  **one file at a time**. Windows only; CI runs on `windows-latest`.
- **No test touches a real session or the real `~/.claude`.** Tests that need sessions open test consoles
  (`TestConsole` in `helpers.ts`, the driver in `--fake-console`). Tests that need a server use
  `parity/harness.ts`: `buildFixture()` makes a throw-away profile and `startServer()` runs the real server on it
  with `USERPROFILE` / `LOCALAPPDATA` pointed there, on a test port, `--no-background`.
- `parity/` is the main integration suite. It was written to compare the historical PowerShell server with the Node
  one; without `legacy/` (this repository) it runs against Node only (`KINDS`).
- **Page tests** (`*-page.test.ts`) do not run a browser: they cut a function out of `page/app.js` with a regular
  expression and run it with `new Function`. `setup-page-globals.ts` provides `T` (French) and `LOCALE`. So a page
  function under test must stay **pure** and findable by its signature; renaming or wrapping it breaks the test's
  extraction, not only its assertions.
- `guard.test.ts` covers the CI guard itself.

## The page (`page/app.js`)

One file, sections marked by `// ── Title ──` comments. Search for those to find your way; the main ones, in order:
language and globals · quota banner · peers · tags · git changes of a session · bulk close and relaunch · board ·
Teams conversations · launcher and its runs · automations · reboot recovery · relay health · navigation (the address
says which screen is open) · config editor · attachments · reply drafts · line editing · `/` commands · per-session
model · prompt suggestion · action buttons (`actionsFor`, pure) · search · new session and drafts · multi-send ·
dialogs, menus and parked questions · full conversation and its Markdown · link with the server (disconnects,
restarts, reload after a hot page swap) · copy on select.

The page polls `/api/state` every 2 s; the state carries the server's boot id and a fingerprint of the page files,
so the page reloads itself after a restart or a hot page swap by `Deploy.ps1`.

## History you will meet in the code

The Node server is a port of an earlier PowerShell server (`legacy/sessions-dashboard.ps1`), which is **not in this
repository**. Some comments still name the PowerShell function a piece of code was ported from (`Get-BusyFix`,
`Invoke-Send`…); `util.ts` reproduces some PowerShell and .NET quirks on purpose, and the parity tests pin that
behaviour. Do not "fix" such a quirk without checking the tests and the page. The code still falls back to a
`legacy/` folder when one exists (`config.ts`, `test/helpers.ts`, `guard.mjs`); leave those fallbacks alone.

## Shipping

- Branch, pull request, CI (`tests` on Windows, `garde` = guard + gitleaks). The guard also checks the pull-request
  title; the description and commits are the author's responsibility.
- Deployment to a machine is `server/watchdog/Deploy.ps1` from a clean, pushed clone (README, "Running it at
  logon"). **A machine with `Auto-Update.ps1` installed deploys `main` by itself once its checks are green**: a merge is
  a release to that machine.
- After a change to `server/watchdog/`, run its PowerShell tests (`deploy-plan-tests.ps1`, `watchdog-tests.ps1`).
