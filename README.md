# Twin

[![CI](https://github.com/SHARAJ379/Twin/actions/workflows/ci.yml/badge.svg)](https://github.com/SHARAJ379/Twin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

Runs two copies of your app and shows you where they disagree.

Most apps get built and tested as a single instance. The moment you run two (behind a
load balancer, in two containers, across a deploy) you find out the hard way that a
session only lived in one process's memory, or a file only landed on one instance's
disk. Twin catches that class of bug before your users do: it boots **one** instance
(the control), then boots **two** (A and B) behind its own proxy, runs the same
scenario against both, and reports anywhere their behavior diverges.

It tests over HTTP, so it doesn't care what your app is written in: **Node.js,
Python, Go, Ruby and PHP** are all supported, detected automatically.

## Install

```bash
npm install -g @sharaj379/twin
twin doctor   # checks your machine can run it
```

The package is scoped but the command isn't - it's `twin` once installed. To
run it without installing: `npx @sharaj379/twin run`. Requires Node.js >= 20.

Working on Twin itself is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Quickstart

From your project's root:

```bash
twin init    # scaffolds scenario.yaml + twin.config.json
twin run     # boots your app, runs the scenario, reports what it finds
```

`twin init` writes a **placeholder** starter scenario, works out which language stack
the project is, and records how to start it. The placeholder hits `GET /health` - if your app has no
such route, that step will fail and Twin will tell you so (exit `2`) rather than
pretend everything is fine. Either point it at a route you do have, or go straight to
the real thing: edit `scenario.yaml` to add steps that create state via one instance
and read it back via the other, which is what actually exercises multi-instance bugs:

```yaml
name: basic-user-flow
version: 1
steps:
  - id: login
    kind: request
    via: A
    request: { method: POST, path: /login, json: { email: "a@test.com", password: "pw" } }
    expect: { status: 200 }
  - id: me-check
    kind: request
    via: B
    request: { method: GET, path: /me }
    expect: { status: 200 }
    check: session-survives-switch
```

Full step/check reference: [docs/scenario.schema.json](docs/scenario.schema.json).

### Testing more than one user at a time

Each step uses its own cookie jar, picked with `as:`. Jars have to be declared
up front, because a typo in `as:` would otherwise quietly send the request
with no cookies at all - and a scenario that believes it's testing two users
would really be testing one anonymous one, green the whole way:

```yaml
name: tenant-isolation
version: 1
clients: [alice, bob]
steps:
  - id: alice-login
    kind: request
    as: alice
    request: { method: POST, path: /login, json: { email: "alice@test.com", password: "pw" } }
    expect: { status: 200 }
  - id: bob-cannot-read-alices-note
    kind: request
    as: bob
    request: { method: GET, path: "/notes/{{noteId}}" }
    expect: { status: 404 }
```

A step with no `as:` uses the `default` jar, which never needs declaring.

### Built-in checks

Tag a `request` step with `check: <id>` to assert multi-instance behavior:

| check                    | what it proves                                                              |
| ------------------------- | ----------------------------------------------------------------------------- |
| `session-survives-switch` | a session started on one instance is still valid on the other                 |
| `data-consistency`        | a record created via one instance can be read back via the other             |
| `file-consistency`        | a file uploaded via one instance can be fetched back via the other           |
| `restart-persistence`     | a record survives a restart of the instance that created it                  |

A step that fails one of these gets a ready-to-paste fix prompt in the report, and
Twin's tracer tries to point at the likely file/line in your source.

The last three checks all sit behind a login, so when the session is the thing that
breaks, their assertion comes back `401`/`403` - refused at the door, with no handler
run and nothing read from any store. Twin says so rather than claiming the record or
file was missing: the finding stays a failure (the CONTROL run proved the same request
works on a single instance), its summary names the session as what diverged, the
tracer points at your session store instead of your data store, and `report.json`
carries `blockedBy: "auth"` on that finding. In practice this means a broken session
shows up as one bug with one cause, not four unrelated-looking ones. The terminal
and `report.md` show those checks as `BLOCKED`, with no fix prompt of their own, and
the summary counts bugs rather than failed checks: "1 bug found
(session-survives-switch); 3 checks couldn't be tested because of it". Exit code is
still `1`. `report.json`'s `verdict.blocked` says how many of `verdict.failed` were blocked.

### Retrying a step that needs a moment (`retries` / `settleMs`)

Some writes aren't readable the instant the write returns - a queue, a cache
write-behind, an `fsync` that hasn't landed. A read-back step that races one of
those fails for a reason that has nothing to do with multi-instance behavior, so
two optional fields let the step wait instead:

```yaml
- id: read-back
  kind: request
  via: B
  request: { method: GET, path: "/notes/{{noteId}}" }
  expect: { status: 200 }
  check: data-consistency
  retries: 3 # re-send up to 3 more times while the expectations keep failing
  settleMs: 250 # wait this long between attempts
```

A step is attempted `retries + 1` times and stops at the first attempt whose
expectations pass, so a passing step costs nothing. `settleMs` only applies
*between* attempts - it never delays the first one. Both default to 0.

Reach for these only when the delay is real: they make a genuinely broken app
take `retries + 1` times longer to fail, and a check that only passes on the
third try is worth reading as a result in itself.

One sharp edge: every attempt re-renders the step, so `{{unique}}`, `{{uuid}}`
and `{{now}}` produce **fresh** values each time. On a read-back step that
interpolates a saved variable (`{{noteId}}`) a retry is identical and safe; on a
step that *creates* something with `{{unique}}`, each attempt creates a separate
record. Put `retries` on the read, not the write.

## Language support

Twin checks behavior over HTTP, so the engine is language-agnostic. What each
stack contributes is how to *boot* it, which dependency directory to share
between instances, and which source patterns to blame when a check fails.

| stack | detected by | start command it guesses | shares |
| --- | --- | --- | --- |
| **Node.js** | `package.json` | `npm start` / `npm run dev` / `serve` | `node_modules` |
| **Python** | `requirements.txt`, `pyproject.toml`, `Pipfile`, `manage.py` | Django `runserver`, `uvicorn`, `flask run`, or the script itself | `.venv` / `venv` |
| **Go** | `go.mod` | `go run .` | *(nothing - compiled)* |
| **Ruby** | `Gemfile`, `config.ru` | `rails server`, `rackup`, or `ruby <script>` | `vendor` |
| **PHP** | `composer.json`, `artisan`, `index.php` | `artisan serve` or `php -S` | `vendor` |

Python start commands use the project's **own virtualenv interpreter** when there
is one, since that's where its dependencies live.

### The `{{port}}` placeholder

Node apps conventionally read `process.env.PORT`, but most other servers take the
port as an argument — and `$PORT` / `%PORT%` aren't portable across shells. So any
start command may contain `{{port}}`, which Twin replaces with the port it
allocated for that instance:

```json
{ "start": "python -m uvicorn main:app --port {{port}}" }
```

`--port-env` still works for apps that read it from the environment instead.

### Polyglot repos

A repo matching more than one stack (say `package.json` *and* `requirements.txt`)
is reported as `E_AMBIGUOUS_STACK` rather than guessed at. Say which one serves
HTTP with `--stack python` or `"stack": "python"`. If Twin can't identify the
stack at all but you pass `--start`, it proceeds and applies every stack's tracer
rules.

### How thoroughly each stack is tested

**Node.js, Python, Go, Ruby and PHP** are all validated end-to-end against real
running apps, in both directions — Twin correctly fails a broken app *and*
passes a correctly built stateless one. `examples/broken-<stack>` /
`examples/fixed-<stack>` are real apps in that language; CI boots them with a
real toolchain for each and asserts `twin run`'s exit code and findings, the
same shape across all five.

## Configuration

`twin run` resolves each setting in this order: **CLI flag > `twin.config.json` >
built-in default / auto-detection**. `twin init` writes `twin.config.json` for you so
a bare `twin run` just works afterward:

```json
{
  "scenario": "scenario.yaml",
  "start": "npm start"
}
```

All fields are optional:

| field           | meaning                                                      | default                              |
| --------------- | -------------------------------------------------------------- | --------------------------------------- |
| `scenario`      | path to the scenario file, relative to the project dir          | *(required from somewhere)*             |
| `stack`         | `node` \| `python` \| `go` \| `ruby` \| `php`                     | detected from marker files               |
| `start`         | shell command that boots the app (may contain `{{port}}`)        | the stack's own detection                |
| `build`         | shell command run once per instance workspace before `start`    | *(skipped)*                             |
| `healthPath`    | path polled for readiness                                       | `/health`                               |
| `portEnv`       | env var name the app reads its port from                        | `PORT`                                  |
| `bootTimeoutMs` | boot timeout per instance, in ms                                 | `60000`                                 |
| `requestTimeoutMs` | deadline for a single scenario request, in ms                 | `30000`                                 |
| `env`           | extra env vars for every instance                                | `{}`                                    |
| `allowRemote`   | allow running even if the environment looks like a real DB/service | `false`                             |
| `allowRemoteHosts` | hosts vouched for individually; a leading dot is a domain suffix | `[]`                                 |
| `redactHeaders` | extra header names to redact from the report's evidence          | `[]`                                    |

On Node, start-command detection checks `package.json`'s `scripts` for `start`,
then `dev`, then `serve`; if none exist but there's exactly one other script, it
uses that. Every stack refuses (`E_NO_STACK`) rather than guess wrong when it
can't tell - pass `--start` or set `"start"` in the config.

## CLI reference

### `twin run`

Boots one instance (CONTROL), then two behind the proxy (SPLIT), runs the scenario
against both, and writes a report.

```
--scenario <path>       path to scenario.yaml (defaults to twin.config.json's "scenario")
--project <dir>         project directory to run (default: cwd)
--stack <id>            node, python, go, ruby, php (default: detected from marker files)
--start <command>       start command (defaults to config, then the stack's detection);
                        `{{port}}` is replaced with the port Twin assigns
--build <command>       build command to run once per instance workspace before --start
--health-path <path>    path polled for readiness (default "/health")
--port-env <name>       env var the app reads its port from (default "PORT")
--boot-timeout-ms <ms>  boot timeout per instance (default 60000)
--request-timeout-ms <ms>
                        deadline for a single scenario request (default 30000)
--redact-header <name>  also redact this header from the report (repeatable)
--env <KEY=VALUE>       extra env var for every instance (repeatable)
--keep-workspaces       don't delete the per-instance tmp workspaces on exit
--allow-remote          allow running even if the environment looks like a non-local DB/service
--allow-remote-host <host>
                        vouch for one host instead, leaving the check on for
                        everything else; a leading dot is a domain suffix
                        (`.mongodb.net` covers a whole cluster). Repeatable
```

Every wait is bounded: no step can take longer than `--request-timeout-ms`
(times `retries + 1`, for a step that has them), and no instance longer than
`--boot-timeout-ms` to come up. An app that accepts the connection and never
answers - or answers with a stream that never ends - fails that step instead
of stalling the run.

### `twin report`

Re-prints a past run's report (from `.twin/runs/<id>/`) without re-running anything -
useful in CI, or to look at a result again after the terminal's scrolled away.

```
--project <dir>    project directory the run happened in (default: cwd)
--run <id>         a specific run id (defaults to the most recent run)
--format <format>  terminal, json, or markdown (default: terminal)
```

### `twin init`

Scaffolds a starter `scenario.yaml` and `twin.config.json`. Never overwrites an
existing file unless `--force` is passed.

```
--project <dir>    project directory to scaffold into (default: cwd)
--scenario <path>  where to write the starter scenario (default: scenario.yaml)
--force            overwrite an existing scenario.yaml / twin.config.json
```

### `twin doctor`

Checks that your machine can run Twin (Node version, platform, git).

### `twin clean`

Clears up after a past run that didn't get torn down cleanly: orphaned
instance processes, and the temp workspaces those instances ran in. Ctrl-C
handles itself - it stops the instances it started and removes their workspaces
before exiting - so this is for the cases that can't: a crash, a killed
terminal, a machine that went to sleep.

```
--project <dir>    project directory to clean (default: cwd)
--unlock           also remove the project's lock, even if its holder can't be ruled out
```

It also removes the project's lock when the run that took it has died. If
the lock's process is still alive but Twin can't confirm it's a Twin run (on
Windows the OS often won't show another process's command line), `twin run`
refuses with `E_LOCKED` and says so, and a plain `twin clean` leaves the lock
alone. Once you're sure no Twin run is in progress, `twin clean --unlock`
removes it.

It only kills a process it can still positively identify as one Twin started.
Operating systems reuse process ids, so a pid recorded by an old run may belong
to something else entirely by now — if the live command line doesn't match, or
if the OS won't say what the process is at all, Twin reports it and leaves it
alone rather than risk killing something of yours. Those it skips are named in
the output, so you can kill them yourself if they really are leftovers.

Workspaces are swept with the same caution. Only directories named exactly
`twin-<run-id>` are considered - never anything else you happen to have called
`twin-something` - and only once an hour has passed since both the run started
and the workspace was last written to, so a run still in flight can't have its
workspace deleted from under it. Anything newer is reported and left.

## Exit codes

| code | meaning                                                             |
| ---- | ---------------------------------------------------------------------- |
| `0`  | at least one check passed and nothing failed - safe to run more than one instance |
| `1`  | at least one check failed - a real multi-instance bug was found        |
| `2`  | Twin couldn't tell (bad scenario, boot failure, Twin's own error, **or nothing was verified at all**) |

That last case matters: a scenario with nothing tagged `check:`, or whose steps
failed their own `expect:`, exits `2` rather than `0`. Twin will not report
success for a run that verified nothing - silence is not a pass.

## Use in CI

See [action.yml](action.yml) for a GitHub Action that runs `twin run` against your
checked-out repo and exposes the report as a step output:

```yaml
- uses: actions/checkout@v4
- uses: SHARAJ379/Twin@v0.1.0
  with:
    project-dir: .
```

Pin a tag, not `@master` - the branch moves, and a CI job that silently
changes behavior is worse than one that needs a version bump.

## Troubleshooting

Twin prints the failing instance's own log tail inline, which usually says it
outright. The common ones:

| symptom | cause | fix |
| --- | --- | --- |
| `E_BOOT_CRASH`, log says `Cannot find module .../dist/...` | the app compiles before it runs | `--build "npm run build"` (or set `"build"` in `twin.config.json`) |
| `E_BOOT_DETACHED` | the start command hands the server off and exits (`pm2 start`, `--daemon`) | run it in the foreground: `pm2-runtime start`, no daemon flag |
| `E_BOOT_TIMEOUT`, app seems fine on its own | Twin polls `/health`, your app doesn't serve it | `--health-path /healthz` |
| `E_BOOT_TIMEOUT`, app logs that it started on the wrong port | the app doesn't read `PORT` | `--port-env APP_PORT` |
| `scenario-ran-as-written` error | a step didn't match its own `expect:` | fix the route/status in `scenario.yaml` - the message names the step and what it got |
| `No checks ran` | nothing in the scenario is tagged `check:` | tag the step that reads state back via the *other* instance |
| `E_UNSAFE_ENV` | something in the environment looks like a real database | point it at a local one, or vouch for just that host with `--allow-remote-host <host>`. The error names which env source set the value |
| `E_NO_STACK` | no marker file identifies the project, or the stack is known but its entrypoint isn't | `--start "<command>"` (and `--stack <id>` to get the right tracer rules) |
| `E_AMBIGUOUS_STACK` | a polyglot repo matches two stacks | `--stack <id>` to say which one serves HTTP |
| Python `ModuleNotFoundError` on boot | the start command used a `python` without the project's deps | let Twin detect it (it uses `.venv`), or point `--start` at the venv interpreter |
| `request timed out after 30000ms` | the app never answered that route, or it streams a response that never ends (SSE) | `--request-timeout-ms` if it's just slow; websockets/SSE aren't supported as scenario steps |
| `"as: x" is not a declared client` | a jar used by a step isn't in the scenario's `clients` | add it to `clients:` - or fix the typo, which is what this usually is |

## How it works

1. **PREFLIGHT** - validates the scenario, scans the environment for anything that
   looks like a real (non-local) database or third-party service, and refuses to run
   against one unless you pass `--allow-remote` (Twin writes real test data).
2. **CONTROL** - boots one throwaway instance and runs the whole scenario against it
   alone, proving the scenario/app works before a SPLIT failure gets blamed on
   multi-instance behavior.
3. **SPLIT** - boots two instances (A, B) behind Twin's own HTTP proxy and runs the
   same scenario against them, pinning specific steps to a specific instance via
   `via: A` / `via: B`.
4. **EVALUATE** - runs the built-in checks against both runs' results.
5. **TRACE** - for anything that failed, scans your source for the likely cause
   (static rules first, then matched against the actual filesystem diff between each
   instance's workspace before/after).
6. **REPORT** - writes `report.json` / `report.md` to `.twin/runs/<id>/`, prints a
   terminal summary with a ready-to-paste fix prompt per failure, and exits 0/1/2.

Each finding points at the steps it judged (`{"run": "split", "stepId": "me-check"}`);
`results.json` in the same directory is what those pointers resolve against - every
step's request, response and timing, from both runs.

Each instance's own stdout/stderr is kept at `.twin/runs/<id>/logs/<instance>.log`,
and the tail of it is printed inline when an instance fails to boot - that output is
usually the whole diagnosis (a missing build step, a wrong port env var, a crash on
startup).

Every run is **ephemeral**: Twin clones your project into temp workspaces per
instance (symlinking `node_modules`), runs there, and tears everything down
afterward. It never touches your actual source tree.

## Security

Twin runs your project's own start command with no sandboxing - see [SECURITY.md](SECURITY.md)
for the full trust model, and where to report a vulnerability.

Two things are worth knowing up front. Twin refuses to run when the
environment looks like it points a datastore somewhere non-local - a
`DATABASE_URL`, a `DB_HOST`, a seed list - because it writes real test data.
The refusal names the host *and* which of the four env sources set it, and
`--allow-remote-host <host>` vouches for one without switching the check off
for everything else (`--allow-remote` does that).

What counts as "local" is a deliberate line, and worth knowing if your
network has short internal hostnames. A dotted name or an IP is remote unless
it's loopback, `*.localhost`, an mDNS `*.local`, or a reserved test name
(`example.com`, `*.test`, `*.example`, `*.invalid`). A **short, dotless name**
(`db`, `redis`, `analytics`) counts as a local container, because that's what it
is in every docker-compose project. That includes a Kubernetes service or
Tailscale short name, which Twin can't tell apart from a container. A short name
that says it's a shared environment (`prod-db`, `staging-db`, `stg-postgres`,
`uat_db`, `primary`, `live-redis`) is still refused, and so is a
`*.svc.cluster.local` address. If your dev env points a short name at a real
shared database, Twin won't catch it, so use a local one.

And everything Twin writes down is redacted
first: reports and `results.json` keep an allowlist of headers with cookie
values masked, and the instance logs (plus the tail printed on a boot failure,
which lands in CI output) have the run's own secrets, URL credentials and
bearer tokens stripped out of them.

## Contributing

Setup, how to run the e2e fixtures, and the pre-1.0 versioning policy are in
[CONTRIBUTING.md](CONTRIBUTING.md). Notable changes are recorded in [CHANGELOG.md](CHANGELOG.md).
