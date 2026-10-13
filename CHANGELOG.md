# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project is pre-1.0, so the
public CLI surface (flags, exit codes, `twin.config.json` fields, scenario schema) may still
shift between minor versions.

## [0.1.0] - 2026-10-13

First published release. Everything below is part of it - the sections exist to say what
kind of change each item was, not to imply a version before this one.

### Added

- `twin init` / `twin run` / `twin report` / `twin doctor` / `twin clean`, the
  CONTROL/SPLIT/EVALUATE/TRACE/REPORT pipeline, and the four built-in checks
  (`session-survives-switch`, `data-consistency`, `file-consistency`, `restart-persistence`).
- Stack support for Node.js, Python, Go, Ruby and PHP, each validated end-to-end in CI
  against real running example apps (`examples/broken-<stack>` / `examples/fixed-<stack>`)
  in both directions: Twin fails a broken app and passes a correctly stateless one.
- `--request-timeout-ms` (config: `requestTimeoutMs`, default 30s): a deadline for every
  scenario request, covering the response body read as well.
- `--redact-header` (config: `redactHeaders`): extra header names to redact from report
  evidence.
- `results.json` per run - the evidence ledger each finding's `{run, stepId}` pointers
  resolve against, holding every step's request, response and timing from both runs.
- Named clients: a scenario declares `clients: [alice, bob]` and steps pick one with `as:`.
- `SECURITY.md` documenting the trust model and vulnerability reporting process; CodeQL,
  Dependabot and an `npm audit` gate in CI.
- `npm run pack:smoke`: packs the tarball, installs it into a clean project and drives the
  installed binary. Runs in CI on Linux and Windows.
- A tag-driven release workflow that publishes to npm with provenance.

### Changed

- Package renamed to `@sharaj379/twin` on npm (the unscoped `twin` and `twin-cli` names were
  already taken); the CLI binary itself is still invoked as `twin` after install.
- Ctrl-C stops the instances it started and removes their temp workspaces before exiting,
  rather than leaving both for `twin clean`.
- `as:` must name a declared client. An undeclared one is almost always a typo, and a typo
  there used to open an empty cookie jar instead of failing - so a scenario that believed it
  was testing two users was testing one anonymous one, and could still come back green.
- The published build embeds sources in its source maps, which ship without the `.ts` files.

### Fixed

- A hung app no longer hangs the run: a response that never arrives, or a stream that never
  ends, fails its step instead. The proxy 504s a silent instance and drops the upstream
  request when the client goes away.
- A crash on boot is reported as soon as the process is gone, instead of waiting out the
  full boot timeout once per attempt.
- Temp workspaces are removed when a run fails, not only when it succeeds.
- An instance that booted is stopped when a later one fails to boot, instead of being left
  running and holding its port.
- Instance log capture closes on the child's `close`, not its `exit`, which could truncate
  the last output and write to an ended stream.

### Security

- The non-local datastore refusal now also reads split-out settings (`DB_HOST`, libpq's
  `PGHOST`, comma-separated seed lists, `jdbc:` URLs), which have no URL to parse and used
  to sail straight past it.
- Instance logs are redacted - the run's own secret values, URL credentials and bearer
  tokens - before they reach disk or the boot-failure tail printed to the terminal.
- The GitHub Action passes its inputs through the environment instead of interpolating them
  into a shell script, where an input containing shell metacharacters would have executed.
