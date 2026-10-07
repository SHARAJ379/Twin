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
npm install
npm run build
npm link   # makes `twin` available on your PATH, or run via `node dist/cli/index.js`
```

Requires Node.js >= 20. Run `twin doctor` to check your machine can run it.

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

Honest status, because it differs:

- **Node.js and Python** are validated end-to-end against real running apps, in
  both directions — Twin correctly fails a broken app *and* passes a correctly
  built stateless one.
- **Go, Ruby and PHP** ship with detection and tracer rules that are unit-tested
  (every rule carries must-match and must-not-match fixtures, enforced in CI),
  but they have not yet been run against a live app of that language. Detection
  and the suspect patterns are tested; the boot path is not. Expect to need
  `--start` on your first try, and please report what it got wrong.

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
| `env`           | extra env vars for every instance                                | `{}`                                    |
| `allowRemote`   | allow running even if the environment looks like a real DB/service | `false`                             |

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
--env <KEY=VALUE>       extra env var for every instance (repeatable)
--keep-workspaces       don't delete the per-instance tmp workspaces on exit
--allow-remote          allow running even if the environment looks like a non-local DB/service
```

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

Kills any orphaned instance processes left behind by a past run that didn't get
torn down cleanly (crash, Ctrl-C mid-run, etc).

```
--project <dir>    project directory to clean (default: cwd)
```

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
- uses: SHARAJ379/Twin@master
  with:
    project-dir: .
```

## Troubleshooting

Twin prints the failing instance's own log tail inline, which usually says it
outright. The common ones:

| symptom | cause | fix |
| --- | --- | --- |
| `E_BOOT_CRASH`, log says `Cannot find module .../dist/...` | the app compiles before it runs | `--build "npm run build"` (or set `"build"` in `twin.config.json`) |
| `E_BOOT_TIMEOUT`, app seems fine on its own | Twin polls `/health`, your app doesn't serve it | `--health-path /healthz` |
| `E_BOOT_TIMEOUT`, app logs that it started on the wrong port | the app doesn't read `PORT` | `--port-env APP_PORT` |
| `scenario-ran-as-written` error | a step didn't match its own `expect:` | fix the route/status in `scenario.yaml` - the message names the step and what it got |
| `No checks ran` | nothing in the scenario is tagged `check:` | tag the step that reads state back via the *other* instance |
| `E_UNSAFE_ENV` | something in the environment looks like a real database | point it at a local one, or `--allow-remote` if you really mean it |
| `E_NO_STACK` | no marker file identifies the project, or the stack is known but its entrypoint isn't | `--start "<command>"` (and `--stack <id>` to get the right tracer rules) |
| `E_AMBIGUOUS_STACK` | a polyglot repo matches two stacks | `--stack <id>` to say which one serves HTTP |
| Python `ModuleNotFoundError` on boot | the start command used a `python` without the project's deps | let Twin detect it (it uses `.venv`), or point `--start` at the venv interpreter |

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

Each instance's own stdout/stderr is kept at `.twin/runs/<id>/logs/<instance>.log`,
and the tail of it is printed inline when an instance fails to boot - that output is
usually the whole diagnosis (a missing build step, a wrong port env var, a crash on
startup).

Every run is **ephemeral**: Twin clones your project into temp workspaces per
instance (symlinking `node_modules`), runs there, and tears everything down
afterward. It never touches your actual source tree.
