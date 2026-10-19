# Configuration and commands

- [twin.config.json](#twinconfigjson)
- [Your database keeps what a run writes](#your-database-keeps-what-a-run-writes)
- [The port your app listens on](#the-port-your-app-listens-on)
- [Storage both copies share](#storage-both-copies-share)
- [Commands](#commands)
- [Exit codes](#exit-codes)
- [What a run leaves behind](#what-a-run-leaves-behind)

## twin.config.json

`twin init` writes this file for you, so a plain `twin run` works afterwards:

```json
{
  "scenario": "scenario.yaml",
  "start": "npm start"
}
```

Each setting is taken from, in order: a command-line flag, then `twin.config.json`, then
Twin's default or what it detects. Every field is optional:

| Field              | What it does                                                                                                    | Default                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `scenario`         | path to the scenario file, relative to the project                                                              | *(needed from somewhere)*      |
| `stack`            | `node`, `python`, `go`, `ruby` or `php`                                                                          | detected from your files       |
| `start`            | the command that starts your app. `{{port}}` in it becomes the port Twin picked                                 | detected                       |
| `build`            | a command run once in each copy's folder before `start`, e.g. `npm run build`                                    | none                           |
| `setup`            | a command run in your project before each phase, e.g. a database reset. It gets each copy's env, plus `TWIN_PHASE` (`CONTROL` or `SPLIT`) | none |
| `healthPath`       | the path Twin calls to know your app has started. Any answer below `500` counts                                  | `/health`                      |
| `portEnv`          | the environment variable your app reads its port from                                                           | `PORT`                         |
| `bootTimeoutMs`    | how long each copy has to start, in milliseconds                                                                | `60000`                        |
| `requestTimeoutMs` | how long one request may take, in milliseconds                                                                  | `30000`                        |
| `env`              | extra environment variables for every copy. `{{shared}}` in a value is explained [below](#storage-both-copies-share) | `{}`                     |
| `sharedPaths`      | folders that really are shared in production (a mounted volume)                                                 | `[]`                           |
| `allowRemote`      | run even if a real (non-local) database is configured. See [SECURITY.md](../SECURITY.md)                         | `false`                        |
| `allowRemoteHosts` | hosts you vouch for, one by one. A leading dot covers a domain: `.mongodb.net`                                  | `[]`                           |
| `redactHeaders`    | extra header names to hide in reports                                                                            | `[]`                           |

A start, build or setup command runs through your system shell: `cmd.exe` on Windows,
`sh` elsewhere.

## Your database keeps what a run writes

Twin's copies of your app are throwaway, but the database they talk to is whatever your
app is configured with. Twin doesn't remove the users and records each run creates.
Either:

- point Twin at a throwaway database: `--env DATABASE_URL=...`, or a SQLite file under
  `{{shared}}` (`"DATABASE_URL": "sqlite:///{{shared}}/twin.db"`), or
- set `"setup"` to a command that resets one (`"setup": "npm run db:reset"`). Twin runs
  it before each phase, so both phases also start from the same state.

Twin reminds you of this when your app has a database configured and no `setup`:
an env var named like one (`DATABASE_URL`, `DB_HOST`, `PGHOST`, `MONGO_URI`,
`REDIS_URL`, ...), or a connection string in the env or the code. A database set up any
other way, like Rails' `config/database.yml`, gets no reminder.

Twin refuses to run at all when that database looks like a real, remote one. See
[SECURITY.md](../SECURITY.md).

## The port your app listens on

Twin picks a free port for each copy and passes it in `PORT`. If your app reads a
different variable, set `portEnv`. If it takes the port as an argument instead, put
`{{port}}` in the start command:

```json
{ "start": "python -m uvicorn main:app --port {{port}}" }
```

Twin only ever connects to your app over `127.0.0.1`, so your app never needs to listen
on the network. Every copy also gets `HOST=127.0.0.1` and `BIND_ADDRESS=127.0.0.1`, so an
app that reads either listens on this machine only. A value you set yourself (in your
shell, a `.env` file, `env` or `--env`) wins.

## Storage both copies share

Both copies run on your machine, so they share its disk. Production servers don't. If
your app keeps data in a file outside its own folder, Twin can't prove it would work on
two servers, and says so (see [How it works](how-it-works.md#what-twin-cant-see)).

When a folder really is shared in production (a mounted volume, a bucket), tell Twin:

- `{{shared}}` in an `env` value, like `"DATA_FILE": "{{shared}}/data.json"`. Twin
  replaces it with a fresh folder that every copy of this run shares, and deletes it
  afterwards. The `examples/fixed-*` apps use this.
- `"sharedPaths": ["/mnt/shared"]` for a real path.

## Commands

| Command       | What it does                                                         |
| ------------- | -------------------------------------------------------------------- |
| `twin run`    | starts your app, runs the scenario, writes a report                  |
| `twin init`   | writes a starter `scenario.yaml` and `twin.config.json`              |
| `twin report` | shows a past run's report again, without running anything            |
| `twin doctor` | checks your machine can run Twin                                      |
| `twin clean`  | cleans up after a run that crashed or was killed                     |

`run`, `init`, `report` and `clean` take `--project <dir>` (default: the current folder).
Every command takes `--help`.

### `twin run`

Starts one copy of your app (CONTROL) and runs the scenario, then starts two copies
behind Twin's own proxy (SPLIT) and runs it again, then compares.

```text
--scenario <path>           path to scenario.yaml (default: twin.config.json's "scenario")
--stack <id>                node, python, go, ruby or php (default: detected)
--start <command>           start command; {{port}} becomes the port Twin picks
--build <command>           run in each copy's folder before --start
--setup <command>           run in the project before each phase, e.g. a database reset
--health-path <path>        path polled until the app answers (default /health)
--port-env <name>           env var the app reads its port from (default PORT)
--boot-timeout-ms <ms>      how long each copy has to start (default 60000)
--request-timeout-ms <ms>   how long one request may take (default 30000)
--redact-header <name>      also hide this header in reports (repeatable)
--env <KEY=VALUE>           extra env var for every copy (repeatable)
--keep-workspaces           keep each copy's temporary folder after the run
--allow-remote              run even if a real (non-local) database is configured
--allow-remote-host <host>  vouch for one host instead; a leading dot covers a domain (repeatable)
```

Nothing can hang a run: every request is bounded by `--request-timeout-ms` (times
`retries + 1` for a step with retries), and every copy by `--boot-timeout-ms` to start.

### `twin init`

Writes a starter `scenario.yaml` and `twin.config.json`, and adds `.twin/` to your
`.gitignore`. It never overwrites an existing file unless you pass `--force`.

```text
--scenario <path>  where to write the starter scenario (default scenario.yaml)
--force            overwrite an existing scenario.yaml or twin.config.json
```

If your app is in a subfolder (say `backend/`), `twin init` says so. Run it there.

### `twin report`

Shows a past run's report again. It exits with that run's exit code, so it works in CI.

```text
--run <id>         a specific run (default: the most recent)
--format <format>  terminal, json or markdown (default terminal)
```

### `twin doctor`

Checks your Node.js version and platform. It also shows whether git is installed, which
only matters for downloading Twin's examples or installing Twin from source.

### `twin clean`

Ctrl-C already stops your app's copies and removes their folders. `twin clean` is for when
that couldn't happen: a crash, a closed terminal, a computer that went to sleep.

```text
--unlock  also remove the project's lock, even if Twin can't rule out its owner
```

- **Processes:** it only stops a process it can still positively identify as one Twin
  started. If the operating system has reused the process id, or won't say what the
  process is, Twin leaves it alone and tells you.
- **Folders:** only folders named exactly like a Twin run (`twin-<run-id>`) in the temp
  directory, and only once an hour has passed since the run started and since the folder
  last changed, so a run still in progress keeps its folder.
- **The lock:** removed when the run that took it is gone. If its process is alive but
  Twin can't confirm it's a Twin run, `twin run` refuses with `E_LOCKED` and plain
  `twin clean` leaves it. When you're sure no run is in progress, `twin clean --unlock`
  removes it.

## Exit codes

| Code | Meaning                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| `0`  | at least one check passed and nothing failed: safe to run on more than one server                          |
| `1`  | at least one check failed: Twin found a real bug                                                           |
| `2`  | Twin couldn't tell: the scenario or app didn't work on one copy, a check wasn't really tested, Twin hit an error, or nothing was checked at all |

A scenario with no `check:` steps exits `2`, not `0`: checking nothing is not a pass.

## What a run leaves behind

Each run writes to `.twin/runs/<id>/` in your project. Twin keeps the last 10 runs.

| File               | What's in it                                                                 |
| ------------------ | ---------------------------------------------------------------------------- |
| `report.md`        | the report, with fix prompts, ready to read or paste                         |
| `report.json`      | the same, for scripts and CI                                                 |
| `results.json`     | every request and response from both runs; each finding points into it       |
| `logs/<copy>.log`  | each copy's own output (`control.log`, `A.log`, `B.log`)                      |

Everything written there has secrets masked first: cookie and token values, passwords,
`Authorization` headers, and your env's secret values in the logs.
