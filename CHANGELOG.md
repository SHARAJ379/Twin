# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project is pre-1.0, so the
public CLI surface (flags, exit codes, `twin.config.json` fields, scenario schema) may still
shift between minor versions.

## [Unreleased]

### Fixed

- Instances get their dependencies again on Node 20, which is the Node version this package
  promises to support. `fs.cp`'s filter reports each path as an extended-length `\?\C:\...`
  path on Node 20 for Windows and as a plain path on Node 22+, so computing a project-relative
  path from it produced the whole absolute path instead - and every decision made from that
  path inverted. Dependency directories were linked at a nonsense location, leaving each
  instance without its `node_modules`, and the app's resulting "Cannot find module" was
  reported as the app crashing on boot. The stack's top-level-only ignore list never matched
  either. A failed link is now a `E_WORKSPACE_LINK_FAILED` error naming the directory rather
  than something swallowed, so a workspace can never again start an app without the
  dependencies the project has.

- Expectation-failure messages no longer quote the response verbatim. A failing `jsonPath:`
  check built `expected $.token to equal "a", got "<the real token>"`, and that string goes into
  `failedExpectations`, a finding's `summary`, report.json, results.json, report.md, the
  ready-to-paste fix prompt and the terminal - none of which body redaction ever reached. A
  scenario asserting on a token, session or email leaked it into a report that promises to be
  safe to paste publicly, and into CI logs. The value is masked entirely when the path names a
  secret, JWT-shaped strings are masked wherever they sit, nested secret keys are masked, and
  the rest is truncated - a real mismatch is still diagnosable.
- A response body with a stray `%` no longer aborts the run. Redacting a form-shaped body
  called `decodeURIComponent` on each field name, which throws `URIError` on `discount%=10`;
  response redaction runs outside any try/catch, so one such body ended the whole `twin run`.
  Nothing in redaction can throw now, and an undecodable name is still matched on its raw text,
  so a secret field can't escape masking by carrying a bad escape.
- A scenario's own `Content-Type` is no longer sent twice. The content type for a `json:`/`form:`
  body was filled in under the lowercase key only, so `Content-Type: application/vnd.api+json`
  kept both spellings and fetch joined them into
  `application/vnd.api+json, application/json` - which servers reject or misparse, and Twin
  then reported as a multi-instance failure. Outgoing header names are lowercased on the way in,
  which fixes the same collision for a scenario-set `Cookie` against the jar's own.
- The project lock holds under a genuine race. The exclusive create closed the plain case but
  left two: the file exists empty for a moment between create and write, and a peer reading it
  then saw an unparseable lock and reclaimed it as stale; and two runs that both judged the same
  stale lock would delete in turn, the second deleting the fresh lock the first had just taken.
  The lock is now published complete (written to a temp path and hard-linked into place),
  reclaiming a stale lock only deletes the exact file that was judged, and taking one is
  confirmed by reading it back.
- The stack's `ignore` list applies at the top level only, as `WorkspaceOptions` always said it
  did. Matched by name at any depth, it dropped real source directories - `src/build/`,
  `lib/dist/` - out of the instance workspace, and the app failed to boot on a missing module.
  `.git`, `.twin` and `node_modules` are still skipped at any depth.
- `killTree` no longer signals a bare pid once its process group is gone. The group kill is
  right for a dead leader, but the single-pid fallback behind it was aiming SIGTERM and SIGKILL
  at a pid the OS is free to have reused. The fallback now only fires while the process Twin was
  given is still alive.
- `E_UNSAFE_ENV`'s machine-readable `details` names the file that declared the remote host, like
  the printed list does, instead of whichever source won the merge.
- `twin.config.json` rejects an empty string where a command or path is required. `"start": ""`
  was accepted and handed to a shell, which reported itself as the app crashing on boot.
- Cookies that share a name are sent longest-path first (RFC 6265 5.4) rather than in arrival
  order, so a server reading only the first gets the more specific one.

- The safety preflight can no longer be switched off by a committed file. Every `.env*` file
  was merged into one map with later files overwriting earlier ones, so a `localhost`
  placeholder in `.env.example` replaced a real `DATABASE_URL` in `.env`: the scan found
  nothing remote and Twin would have written test users and records into the production
  database, which is the one thing it promises never to do. Template files nothing loads
  (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) are no longer read at all, and
  the scan now looks at every value every source declares rather than at one winner per key -
  losing a merge is not a way out of being scanned. The refusal names the exact file.
- Secrets in form-encoded bodies no longer reach `report.json` and `results.json`. Only JSON
  bodies were masked, so `email=a&password=hunter2` - an HTML form login, and the most likely
  first step in any scenario - was written to disk verbatim under a "safe to paste" promise.
  Field names are matched by word rather than by exact name, so `access_token`, `accessToken`,
  `refreshToken`, `apiKey`, `client_secret` and `password_confirmation` are masked too; they
  all used to come through in the clear. `author`, `keyword` and `tokenizer_version` are left
  alone, because an over-masked body is evidence nobody can read.
- A `disk: fresh` restart now gets a genuinely clean disk. The clone copied the pristine tree
  *into* whatever was already in the instance's directory, so a file the app created at
  runtime - a SQLite database, a JSON store, an upload - was not in the pristine tree, nothing
  overwrote it, and it survived the restart. `restart-persistence` therefore passed for an app
  that keeps its data in a runtime-created file, which is exactly the app it exists to fail.
- `PWD` is no longer treated as a secret. It is in essentially every shell environment and its
  value is the current directory, so Twin masked the project path out of every log line
  mentioning it - including `cannot open <redacted>/data.db`, the boot-failure diagnosis the
  log tail exists to deliver. `DB_PWD` and `MYSQL_PWD` are still secrets.
- Every `Set-Cookie` of a response is recorded, not just the last. `Headers.forEach` yields
  `set-cookie` once per cookie, so collecting them into a map by name kept one: a login that
  sets a session cookie and a CSRF cookie recorded one of them, and `save: header:set-cookie`
  and the evidence ledger both lost the rest. The cookie jar was always correct.
- Ctrl-C during boot no longer leaks the instance. A spawned process was recorded only after it
  passed its health check - up to three attempts of a 60s timeout later - so for that whole
  window it was in neither `stopAll`'s list nor `pids.json`, and an interrupt left it running
  where `twin clean` could not see it to reap it.
- Two `twin run`s started at the same moment can no longer both take the project lock. The lock
  file was read and then written, and both runs read the same empty path; it is an exclusive
  create now, so one wins and the other is told who holds it.
- A boot failure's log tail waits (briefly, bounded) for the app's output to drain. A process
  can be observed dead before its pipes are read, so the tail could come back empty and leave
  the failure undiagnosable - which also made the test for it flaky.
- Dependency directories are linked at every depth, not only at the project root. The copy
  filter drops every directory named `node_modules`/`vendor` wherever it is, so an
  npm-workspaces or monorepo package was left with no dependencies at all and the app could
  not boot.
- `killTree` no longer gives up on a process group whose leader has already exited. A start
  command like `npm start` can die while the server it spawned keeps running and keeps the
  port; the early return left exactly that process alive.
- `$.items[]` is now rejected as the typo it is, instead of resolving to index 0 (`Number("")`
  is 0), which quietly saved the first element and looked like it worked. An index must be a
  plain integer.
- A `jsonPath:` expectation compares values structurally instead of by `JSON.stringify`, which
  depended on key order - an app emitting its fields in a different order than the scenario
  listed them failed a check it should have passed, and under Twin that reads as a
  multi-instance bug.
- Two cookies that share a name but differ by `Path` are both kept, rather than the second
  evicting the first.
- A malformed `--env` value is reported as a usage error naming the flag, not as an unhandled
  plain `Error` with a stack trace.

- The tracer finds suspects in CRLF files again - which is every file in a Windows checkout,
  since git converts line endings on the way out (`core.autocrlf`). Lines were split on a bare
  newline, leaving a carriage return at the end of each one, and that defeated every rule
  anchored with `$`: a JavaScript `.` matches anything except a line terminator, so a pattern
  ending `(//.*)?$` could not cross the carriage return to reach end-of-input. The lines it
  silently skipped were exactly the ones carrying an explanatory comment - `const items = [];`
  still matched, `const items = []; // { id, name }` did not - so on Windows the seven node,
  python, ruby and php rules that tolerate a trailing comment found nothing, and a failing
  check was reported with no "likely cause" line at all. Go was unaffected: its pattern has no
  `$` for a carriage return to get in front of.

- A check whose request came back `401`/`403` no longer reports the store it never reached as
  missing. `data-consistency` used to say "a record created via one instance could not be read
  back" for a read-back the app refused at the door - a claim Twin never tested, since no
  handler ran. Such a finding is still a failure (the control run proved the same request works
  on one instance) but it now says the session is what diverged, and the tracer points at the
  session store instead of the data store. `restart-persistence` reads back via the instance it
  just restarted, so it says the session was refused by that same instance after the restart
  rather than blaming a second instance that was never in the request.
- The tracer ranks a suspect's relevance to the failing check above where the evidence came
  from. A workspace diff is proof about the file it came from, so the upload directory used to
  lead `data-consistency`'s suspects - pushing the in-memory record store the check is actually
  about off the end of the three-suspect cap. Dynamic evidence still wins among suspects of
  equally relevant kind.
- `twin clean` removes the temp workspaces a past run left in the system temp directory, not
  just its orphaned processes, and does so even when the project has no `.twin/runs` at all -
  which is how they usually get stranded. It only touches directories named exactly
  `twin-<run-id>`, and only once an hour has passed since both the run started and the
  workspace was last written to, so a run still in flight can never have its workspace
  deleted underneath it.
- The multi-stack acceptance tests delete the shared state directories they create, instead of
  leaving one per stack per run in the system temp directory.

### Added

- `report.json` findings carry `blockedBy: "auth"` when the assertion was refused before it
  reached the subject the check is named after. Additive, so `schemaVersion` stays `1`.

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
- Step-level `retries` and `settleMs`, for a read-back whose write isn't readable the
  instant it returns. A step runs `retries + 1` times and stops at the first attempt whose
  expectations pass; `settleMs` waits between attempts only.
- `--allow-remote-host <host>` (config: `allowRemoteHosts`): vouch for one datastore host instead of
  switching the whole remote-environment check off. A leading dot is a domain suffix, so
  `.mongodb.net` covers every shard of a cluster.
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
- The SPLIT phase has one teardown path instead of two, so a failure in the stages that sat
  between them - the before-run snapshots, and the proxy binding its port - no longer returns
  with the instances still running and the proxy still bound.
- Instance log capture closes on the child's `close`, not its `exit`, which could truncate
  the last output and write to an ended stream.

### Security

- The non-local datastore refusal now also reads split-out settings (`DB_HOST`, libpq's
  `PGHOST`, comma-separated seed lists, `jdbc:` URLs), which have no URL to parse and used
  to sail straight past it. The refusal also names which env source set the value, so the
  fix doesn't start with a guess.
- YAML alias expansion in a scenario is bounded instead of unlimited, so a mistyped anchor
  is a parse error rather than an out-of-memory crash.
- Workspace snapshots hash file contents rather than falling back to size and mtime for
  large files, which could report an in-place rewrite as unchanged and cost the tracer its
  evidence.
- Instance logs are redacted - the run's own secret values, URL credentials and bearer
  tokens - before they reach disk or the boot-failure tail printed to the terminal.
- The GitHub Action passes its inputs through the environment instead of interpolating them
  into a shell script, where an input containing shell metacharacters would have executed.
