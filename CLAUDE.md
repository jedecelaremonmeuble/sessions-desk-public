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
