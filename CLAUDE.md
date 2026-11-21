# sessions-desk — working rules

This repository is public. Everything written here — files, pull-request titles and descriptions, commit
messages, comments — is readable by anyone.

- **No internal references.** No name of a colleague or customer, no real ticket number, no company or internal
  tool name, no path from someone's machine, no internal document. The `garde` CI job checks files and the
  pull-request title (`node server/scripts/guard.mjs`); descriptions and comments are the author's responsibility.
  The rules of the session tagger live in the machine's configuration (`tagger` section), not in the repository.
- **No credentials, ever**: no token, password or key, in any file. `gitleaks` reads every file.
- **Nothing machine-specific in the code.** A path, an address, a team or a person's name comes from the machine's
  configuration (`~/.claude/sessions-desk/config.json`, `server/src/modules.ts`), never from a default value. An
  integration only one team has is an optional module, off by default.
- **Test data is fictional**: ticket numbers like `HD-111111`, addresses at `example.com`.
- Source comments, test names and the interface are in French; the README and this file are in English.
- Tests never touch a real session: they open their own test consoles. Never start a test server on the
  production ports (8765 to 8768).

## Before changing code

Read `docs/ARCHITECTURE.md`: module map, where a session's status comes from, the HTTP route sets, the driver
protocol, tests, and the traps below in more detail.

- **Ports.** 8765 is the main server of a real machine (write allowed), 8766 its relay, 8767/8768 the read-only
  instance. Tests use 8831–8834 (`parity/harness.ts`), the demo 8851. Anything else you start: another free port,
  with `--no-background` and a throw-away profile (`buildFixture()`).
- **Tests run one file at a time** (`fileParallelism: false`): the driver attaches to one console at a time. Do not
  turn parallelism on. `npm run typecheck` and `npm test` in `server/` before every pull request.
- **Page tests cut functions out of `page/app.js`** by regular expression. Keep tested page functions pure and keep
  their signature line when you edit them.
- **A new route** goes in the route sets at the top of `server/src/http.ts` (actions, remote, never remote, module)
  and in `server/test/security.test.ts`. A slow handler blocks the queue that serves every action.
- **A new setting** goes in `server/src/modules.ts`, `config.schema.json`, `config.example.json` and the README; in
  `PROTECTED` (`config-edit.ts`) if it runs a program or widens access; in `restartKeys` (`config.ts`) if it cannot
  apply without a restart.
- **`legacy/` is not in this repository.** Comments naming PowerShell functions (`Get-BusyFix`, `Invoke-Send`…) and
  the PowerShell-like quirks in `util.ts` come from the port of an earlier server; the parity tests pin that
  behaviour. Do not look for those files, and keep the `legacy/` fallbacks in the code.
- **Merging is releasing.** A machine with `Auto-Update.ps1` installed deploys `main` by itself once its checks are
  green.
