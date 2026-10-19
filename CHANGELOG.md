# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project is pre-1.0, so the
public CLI surface (flags, exit codes, `twin.config.json` fields, scenario schema) may still
shift between minor versions.

## [Unreleased]

### Fixed

Found by running Twin against a real FastAPI app:

- A step with no `check:` that passed on a single instance but failed across two was
  reported as an error telling you to "fix the scenario", and the run exited `2`. It is
  a multi-instance bug, and is now reported as an `instance-divergence` failure (exit
  `1`) with a fix prompt and suspects, named after the first step to diverge. A step
  that fails on a single instance too, or gets no answer at all, is still a scenario error,
  and one that fails only after a check already caught a bug counts as that bug's
  consequence rather than a second bug.
- Every run said "the app is configured with a database ... Twin does not remove them"
  even when `DATABASE_URL` pointed under `{{shared}}`, the throwaway directory Twin
  creates and removes itself.
- A Python virtualenv not named `.venv` or `venv` (`.venv-backend`, say) was copied
  into every instance's workspace and read by the safety scan and the tracer. Any
  folder with a `pyvenv.cfg` is now shared like `.venv` and skipped by every scan.
- `twin init` and `twin run` on a repo with the app in a subfolder said only "could not
  tell what kind of project" this is. They now name the subfolders a stack recognises
  (`"backend" looks like a Python project`) and say to run Twin there.

Found in the pre-release audit:

- **Safety:** a connection string whose password holds an unencoded `/`, `?` or `#`
  (`postgres://admin:p/ss@db.prod.example.com/app`) passed the check for a real
  database: the host was read as ending at the password's `/`. It is now found and
  refused like any other remote host.
- **Secrets:** a response or request body masked only fields with a secret-sounding
  name, so a credential under an ordinary one - a GraphQL login's
  `{"data": {"login": "<JWT>"}}`, a new API key returned as `{"result": "sk_live_..."}` -
  was written whole into `results.json`. JWT-shaped values and known key prefixes
  (`sk_live_`, `ghp_`, `AKIA`, ...) are now masked wherever they appear in a body.

## [0.1.1] - 2026-10-18

### Fixed

- On Windows, running Twin against a Go app brought up Windows Firewall's "Do you want to
  allow public and private networks to access this app?" for every instance (control, A, B)
  on every run. Twin started Go apps with `go run .`, which links a new executable into a
  new temp folder each time, and the firewall asks about each new executable that listens
  on the network. Every answer also left firewall rules behind for a path that was already
  gone, and every `go run` Twin stopped left its temp build folder behind too (one machine
  had 917 of them, 4.7 GB). Twin now compiles a Go app once per run, with
  `go build -o <cache>/twin/bin/<hash of the project path>/<folder name>`, and starts every
  instance from that executable. The path is the same on every run of a project, so an app
  that does listen on the network is asked about once, ever. The compile still happens
  outside every boot timeout. A start command of your own, or a `build`, turns it off.

### Added

- Every instance gets `HOST=127.0.0.1` and `BIND_ADDRESS=127.0.0.1` in its environment
  unless you set them yourself (in your shell, a `.env` file, twin.config.json `"env"` or
  `--env`), so an app that reads its listen address from either listens only on this
  machine. Twin only ever connects over `127.0.0.1`.

### Changed

- The note that the scenario writes real records to the app's database, which Twin doesn't
  remove, only appears when the app has a database configured: an env var named for one
  (`DATABASE_URL`, `DB_HOST`, `REDIS_URL`, ...) or a connection string in the env or the
  code. It names that setting. It used to appear on every run without a `setup`, database
  or not.
- Releases are published through npm trusted publishing (OIDC) from the release workflow,
  still with provenance. The workflow no longer uses an npm token.
- Every example app listens on `127.0.0.1` only. The Go and Node ones listened on every
  interface, and a test now fails if any example does.
- README: a Troubleshooting row for the Windows Firewall prompt (harmless, and Cancel is
  fine), and sections on listening on `127.0.0.1` and on how Go apps are compiled.

## [0.1.0] - 2026-10-18

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
- `"setup"` in `twin.config.json` (or `--setup`): a command run in the project before CONTROL and
  before SPLIT, typically a reset of a throwaway database (`npm run db:reset`), with the
  instances' env plus `TWIN_PHASE`. A failing setup stops the run with `E_SETUP_FAILED` before
  anything boots.
- `report.json` findings carry `blockedBy: "auth"` when the assertion was refused before it
  reached the subject the check is named after. Additive, so `schemaVersion` stays `1`.

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
- A start command that exits 0 is called a hand-off (`E_BOOT_DETACHED`, never retried) only when
  something it started is demonstrably still out there - Twin's pipes still held, or Twin's port
  answering once the process group is gone - and that now also covers a server that answered
  health before its launcher exited. An exit 0 that leaves nothing behind is a crash ("exited (exit
  code 0) instead of serving") and is retried, as before. Exit code 0 alone was taken as proof of a
  hand-off, which turned a one-off early exit on a macOS CI runner into an unretried failure.
- A likely-cause line is listed once, even when it is both runtime evidence and a static rule's
  match; the duplicate crowded a different suspect out of the three shown.
- A session failure only names session-specific code as its likely cause - a session store, or a
  container named for sessions or tokens - and says "no confident suspect" when there's none,
  instead of pointing at a data container like `const items = []`.
- The Node tracer finds module state declared alongside more statements
  (`const notes = new Map(); let nextId = 1;`), and multer uploads saved to local disk
  (`multer({ dest: ... })`, `multer.diskStorage(...)`) unless the path comes from an env var.
- A Flask session failure is blamed on its secret key when that key falls back to a random one
  (`os.environ.get("SECRET_KEY") or os.urandom(24)`, `or secrets.token_hex(...)`, `or uuid4().hex`,
  or a random default). The rule only knew the bare `secret_key = os.urandom(24)` form, and the
  failure was blamed on `items = {}`.
- A step with no `via:` and no `check:` stays on the instance where its client's last successful
  request went, where its session lives; only check steps cross instances. Round-robin sent a
  setup step like `create-note` to the instance without the session, so one session bug turned
  into "3 bugs found". Explicit `via:` (and `via: any`) behave as before.
- A check whose own request was never sent - an earlier step failed and didn't save the `{{var}}`
  it needed - is reported as BLOCKED by that step, never as a bug of its own and with no fix
  prompt. It was reported as failing ("could not be read back (status no response)") and
  counted in "N bugs found".
- A Go app's first compile no longer counts against the boot timeout. Once timeouts stopped being
  retried, `go run .` on a cold machine could spend the whole timeout compiling (CI's Windows
  runner did). The Go stack now runs `go build .` as a build step before its detected
  `go run .`, and a timeout whose app printed nothing says it was probably still starting.
- `twin run` inside any `examples/broken-*` app works with no flags too (exit 1); they had no
  `twin.config.json`, so it stopped at "no scenario given".
- An unquoted template inside a flow mapping (`request: { path: /items/{{id}} }`) gets the same
  single "has to be quoted" error as `path: {{id}}`. It's a YAML syntax error there, not a nested
  mapping, and it came out as a dozen raw "Unexpected flow-map-start" errors running on through
  the following lines.
- The install instructions work, and CI runs them. The README installs from npm
  (`npm install -g @sharaj379/twin`, or `npx @sharaj379/twin`), from source (clone,
  `npm install`, `npm run build`, `npm install -g .`, in macOS/Linux and Windows PowerShell
  form), or the latest unreleased `master` (`npx --allow-git=all github:SHARAJ379/Twin`: npm
  12 refuses git packages without `--allow-git`). An interim README line,
  `npm install -g github:SHARAJ379/Twin`, failed on every OS - npm builds a git package inside
  the global install, where its devDependencies (`tsc`, `@types/node`) are never installed -
  and is gone. A new `Install` workflow extracts every install block the README marks and runs
  it exactly as written on clean Linux and Windows runners, with each supported Node's own npm
  and with npm 12, weekly as well as on every push, then runs `--version` and `doctor`. The
  pack smoke test also installs the tarball globally into a prefix and npm cache whose paths
  contain spaces, and the release workflow installs each published version from npm on clean
  Linux and Windows runners (the Windows one with a space in the user profile path) and runs
  it against an example app.
- The release workflow sets up every language toolchain before `npm publish`. Publishing runs
  the full test suite, whose fixture tests refuse to skip in CI, so with only Node set up the
  first release would have failed at its own tests.
- The GitHub Action no longer forces Node 20 onto the job (it uses the Node on PATH, or the new
  `node-version` input), and installs the project's own dependencies first (new `install` input,
  `auto` by default). Without them, a Node app following the README's snippet ended in
  `E_BOOT_CRASH`. A new CI job runs the Action against the fixed and broken examples.
- `twin run` inside any `examples/fixed-*` app passes with no extra flags. They needed a shared
  `SESSION_SECRET`, `DATA_FILE` and `UPLOAD_DIR` that only the e2e tests set, so following the
  README exited 1. Each now has a `twin.config.json` that points them at `{{shared}}`, and
  `examples/README.md` says what that stands in for.
- A store that A and B share only because Twin runs them on one machine no longer passes as
  safe. An app keeping its items in `/tmp/twin-demo-items.json`, or at an absolute `DATA_FILE`,
  passed data-consistency and restart-persistence ("safe to run on more than one instance", exit
  0) and broke on two servers. Twin now notes every absolute local path in the env, snapshots
  those paths and the temp directory's data files around SPLIT, and if anything there was
  written, reports each passing check as NOT PROVEN (exit 2). Storage that is shared in
  production too can be declared: `"sharedPaths"` in `twin.config.json`, or `{{shared}}` in an
  env value - a per-run directory every instance shares, standing in for a shared volume.
- Every run says, in the terminal and the README, that the scenario's records stay in the
  database the app is configured with. Nothing said so, and a dev database filled up with test
  users one run at a time.
- An app that ignores `PORT` costs one boot timeout, not three. A boot is retried only after a
  lost port race or a crash; an instance that stayed up but never answered was retried twice
  more, three minutes at the default timeout. When the app's own log announces a different port
  ("listening on port 3000"), the error says so and how to fix it.
- `twin init` adds `.twin/` to the project's `.gitignore` (creating it if missing, never
  duplicating the entry), and the README no longer claims Twin "never touches your actual source
  tree": it writes `.twin/`, and the instances share the real `node_modules`/`.venv`/`vendor`.
- On Windows, a slow first process lookup no longer makes a lock's holder "unknown". PowerShell's
  first CIM query on a machine can take over ten seconds; it timed out, and a stale lock whose
  pid had been reused was refused as unconfirmable. A timed-out lookup is now asked once more
  with 30 seconds to answer.
- Fix prompts read as sentences and copy cleanly. The summary ran into the next sentence with no
  full stop ("...(status 401) Fix the underlying issue..."), and the terminal wrapped the prompt
  in quotes although it contains its own; it's now an indented block.
- One session bug is reported as one bug. On `examples/broken-express` the summary said "4 of 4
  checks failed" and printed four fix prompts, though three of those checks were only 401'd by
  the session bug. Checks with `blockedBy: "auth"` are now shown as `BLOCKED` with no fix prompt
  of their own, and the summary reads "1 bug found (session-survives-switch); 3 checks couldn't
  be tested because of it". Exit code is still 1; `report.json` adds `verdict.blocked`.
- The source scan reads config files named after an environment (`config/database.test.yml`,
  `settings.spec.json`): only test *code* is skipped by name, as are the test, tests, spec,
  `__tests__`, e2e and fixtures directories.
- A lock whose holder can't be identified is never a permanent lockout. When the holder's pid is
  alive but the OS won't show its command line (common on Windows), `E_LOCKED` says Twin couldn't
  confirm it's a Twin run and names `twin clean --unlock`, a new flag that removes the lock
  whatever holds it.
- A boolean that legitimately differs per instance no longer fails a correct app. "True turned
  false" counts as lost data only for flags that report the scenario's own state
  (`authenticated`, `isLoggedIn`, `hasSession`, `valid`, `ok`, `success`, `exists`, `found`,
  `isOwner`...); `cached`, `fromCache` and `isFirstVisit` differing is a per-process cache working.
- The response-fingerprint salt is per run, not per process, and a test proves it never reaches
  `.twin/` (results, report, logs) or the terminal in any encoding.
- The safety scan's line for short hostnames is now deliberate and documented (README
  "Security"). A dotless name is a local container, but one that names a shared environment -
  `staging-db`, `stg-postgres`, `uat_db`, `preprod`, `prod2-db`, alongside `prod`/`live`/`primary` -
  is refused, as is a Kubernetes `*.svc.cluster.local` address, which the `.local` (mDNS) rule
  had let through.
- The response check compares full responses, and catches the shapes it missed. It compared the
  2KB previews the report keeps, and a truncated preview was skipped, so `{"user": null, ...}`
  passed whenever the body was large. It never compared booleans, so `{"authenticated": false}`
  passed. And it only noticed null, empty or missing values, so a fallback `{"user": "guest"}`
  passed. Each step now records a fingerprint of the whole response - field kinds and salted
  hashes, never values - and a string counts as replaced when the control run's value was data
  the scenario established (sent, or received earlier) and the split run's is something that run
  never saw; generated ids and timestamps are never held to that.
- Docker Compose projects aren't refused. A dotless host is a compose service whether it's bare
  (`DB_HOST=db`) or in a URL (`postgres://u@db:5432`); the URL form was refused, which refused
  every Compose project once `docker-compose.yml` was scanned. RFC 2606 names (`example.com`,
  `.test`, `.example`, `.invalid`) are never treated as real servers, and the source scan skips
  tests and fixtures, which hold real-looking connection strings on purpose.
- A stale lock can no longer lock a project out for good. A live pid isn't a live run: the OS
  recycles pids, and in a container Twin is often pid 1, so after one killed run every later run
  found "pid 1" alive and refused. A lock carrying our own pid now counts only if this process
  holds it, and any other live pid must still look like the Twin run that wrote it. `twin clean`,
  which the error points to, now clears a lock whose run has died - it reported "nothing to clean
  up" and left the lock in place.
- Tokens that are part of a URL path (`/reset/<token>`, `/verify/<code>`) are masked in the
  evidence, as query-string tokens already were.
- A start command that backgrounds its server (`node server.js &`, a script that does the same)
  works on macOS and Linux: the instance is judged by its process group, which the server stays
  in, not by the launching shell, which exits at once. That shell exiting used to be reported as
  a crash ("exit code 0") three times over; the group wasn't killed because its leader was
  "already dead", its pid record was dropped so `twin clean` couldn't find it, and the orphaned
  servers held Twin's stdout/stderr pipes - so Twin never exited, and a CI job hung until the
  runner's timeout. A command that hands its server to something outside Twin entirely
  (`pm2 start`, a `--daemon` flag) now fails once with `E_BOOT_DETACHED`, saying to run it in the
  foreground, and is not retried; Twin releases the pipes either way, and `twin clean` reaps a
  process group whose leader has exited.
- Two easy scenario typos get one error that says what to do. An unquoted template
  (`path: {{id}}`) printed a raw yaml-library warning and then errors about a nested mapping
  nobody wrote; it now says to write `"{{id}}"`. `status: "200"` says to write `200`. And a
  request step's errors no longer include the restart and wait step shapes' complaints
  ("must have required property 'instance'", "unknown property 'request'").
- A check now fails when the split run's response lost data the single instance returned, even
  if it passed the scenario's own `expect:`. An app keeping sessions in memory, whose logged-out
  `/me` answers `200 {"user": null}`, passed the README's own scenario (which expects only a
  200): the control run returned `{"user":"alice"}`, the split run `{"user":null}`, both were in
  results.json, and Twin said it looked safe. Only a value the control run had and the split run
  lost counts - a field gone null, empty or missing, an emptied body, a different status - so the
  ids, timestamps and emails that differ between any two runs never do.
- The safety preflight catches the production services its name-based matching missed. A value
  with a datastore scheme (`mongodb+srv://`, `postgres://`, `rediss://`, ...) is checked whatever
  the variable is called, so `ATLAS_URI` no longer walks past it; `KV_URL`, `CONVEX_URL`,
  `CLOUDINARY_URL`, Firebase, S3/R2/MinIO and other hosted backends are recognised by name; a
  bucket, a Firebase project id or `GOOGLE_APPLICATION_CREDENTIALS` is refused unless an
  emulator or local endpoint is configured; and a dotless host that names production
  (`DB_HOST=prod-db`) is no longer read as a docker-compose service. Connection strings
  hardcoded in the source (`mongoose.connect("mongodb+srv://...")`) are scanned too.
- The third-party warning covers Resend, PayPal, Braintree, Mailchimp, Slack, AWS credentials and
  more, and only fires on names that carry a credential - so `ANTHROPIC_BASE_URL` no longer
  triggers it, and the ones that matter aren't lost among the ones that don't.
- Each run's temp workspace root is created owner-only (0700), and refused if something else is
  already at that path. Every workspace is a full copy of the project, `.env` included; the root
  was world-readable, so other users on a shared machine or CI runner could read the app's
  secrets for as long as `--keep-workspaces` or a crash left them there.
- Credentials in URLs and HTML are masked in the evidence. `Location` was kept verbatim and
  request paths raw, so a magic-link or OAuth redirect (`?session=`, `?code=`,
  `#access_token=`) and a `/verify?token=` step saved the real credential into results.json; a
  page's CSRF token in a hidden field or meta tag did too.
- A check no longer passes when its read never left the instance that did the write. Steps
  without `via:` are round-robined, so create, one unrelated GET, read back routed A, B, A: an
  app keeping everything in memory passed data-consistency and was called safe to run on more
  than one instance. The same hole let session-survives-switch pass with both requests on one
  instance, and restart-persistence pass with the read-back on the instance that wasn't
  restarted. A tagged check step with no `via:` is now sent where it has to go: the other
  instance from its write, or the instance restarted since. And every check confirms it from
  `instanceServed` - if the routing never exercised the check (an explicit `via: any`, or a
  `via:` naming the wrong instance), the result is "not tested", never a pass.
- A Ruby app with no Gemfile or config.ru is detected from `app.rb`, `server.rb` or `main.rb`
  and started with `ruby <script>`. `examples/broken-ruby` and `fixed-ruby` are exactly that,
  and `twin run` on them failed with `E_NO_STACK`; their end-to-end tests only passed because
  they forced `--stack ruby --start "ruby app.rb"`, which they no longer do. A script name only
  counts when no stack's usual markers are present, so it can't make another project ambiguous.
- Taking over a stale project lock no longer moves or deletes anything. Two runs could both
  judge the same stale lock reclaimable, and the slower one then removed the fresh lock the
  faster run had already taken - first with a delete, and then, after the delete was "fixed",
  with a rename, which is atomic about the move but renames whatever is at the path by then.
  Either way both runs believed they held the lock. The lock is now a series of files
  (`.twin/lock.1`, `lock.2`, ...); the holder is the live owner of the highest one, and taking
  it means exclusively creating the next number, so a claim on a lock judged stale fails if
  anyone has claimed it since. This also removes the misleading "another twin run is starting
  at the same moment" error on Windows when antivirus held the stale lock file open: nothing
  has to remove that file any more.
- The lock no longer refuses to work on a filesystem without hard links. FAT/exFAT and some
  network and container bind mounts answer `EPERM`/`ENOTSUP`, which was rethrown, so `twin run`
  could not take the lock there and refused to start every time. It falls back to an exclusive
  create on those filesystems.
- `killTree` only signals a bare pid when the caller has confirmed the pid is still the process
  it recorded, which `reapOrphans` does by matching the live command line. Gating that on
  whether the pid was alive looked like protection and wasn't: a recycled pid is alive by
  definition, so the guard skipped only the harmless case and still signalled an unrelated
  process in the one that matters.
- Expectation-failure messages mask opaque credentials, not just JWTs and secret-looking field
  names. A `sk_live_...` key at `$.data.value` and a 32-character hex session id at
  `$.tokens[0]` both reached the report. Any segment of the path naming a secret now masks the
  value (only the last was checked, so `$.tokens[0]` - ending in the index `0` - slipped
  through), known credential prefixes and long opaque high-entropy tokens are masked wherever
  they sit, and UUIDs are left alone because a record id is the most likely thing to be
  asserted on.
- Field names the user declared secret with `--redact-header`/`redactHeaders` now reach the
  failure message too. They were applied to the body preview only, so a field the user had
  explicitly asked to be redacted was masked in one part of the report and printed in full in
  another.
- Failure messages no longer mask ordinary ids and paths. A MongoDB ObjectId, a file path like
  `uploads/twin-test-4f2a1b2c.txt`, and anything under a plural like `$.keys[0].owner` all read
  `<redacted>`, which hid the evidence a data- or file-consistency mismatch exists to show.
  Hex under 32 characters is treated as an id, `.` no longer counts as a token character, and
  a plural segment (`tokens`, `keys`) masks only when it is the last named part of the path.
- `--start ""` is rejected like an empty `"start"` in twin.config.json. The config check added
  for this missed the flag, where an empty string is not "unset": it won the fallback chain,
  suppressed stack detection, and was handed to a shell, which reported itself as the app
  crashing on boot.

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

### Known limitations

- Hardcoded data paths outside the temp directory (for example `/var/lib/app/data.json`) can
  still pass: in process mode both instances share one disk, and Twin only watches absolute
  paths it finds in the env and data files directly in the temp directory. Container isolation
  (planned) is the real fix.
- A field replaced by a different server-generated value (`"role": "member"` becoming
  `"anonymous"`) isn't caught unless the scenario itself sent or received the original value.
- When only `data-consistency` fails, its likely-cause list can include upload code (multer)
  that belongs to `file-consistency`.
