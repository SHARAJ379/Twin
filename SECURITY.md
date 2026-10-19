# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/SHARAJ379/Twin/security/advisories/new)
rather than opening a public issue. You should get a response within a few days.

Include:

- A description of the issue and its impact
- Steps to reproduce (a minimal `scenario.yaml` / project layout helps)
- The Twin version and OS you're running

## Supported versions

Twin is pre-1.0 (`0.x`). Only the latest published version receives fixes.

## Trust model

Twin is a local developer tool, not a sandboxed execution environment. Running `twin run`:

- **Executes your project's own start command** (detected, or passed via `--start`) exactly as
  `npm start`/`go run .`/etc. would. Twin does not sandbox or restrict what that command can do -
  if you wouldn't run the command yourself, don't point Twin at it.
- **Writes real test data** against whatever your app is configured to talk to. The PREFLIGHT
  step scans the environment and your code for anything that looks like a non-local database
  or storage service and refuses to run against it. `--allow-remote-host <host>` vouches for
  one host and keeps the check on for everything else; `--allow-remote` turns it off. Treat
  either as "I am sure this is safe to write test data into," not as a feature to use by
  default. The scan is a safety net, not a guarantee: it recognises connection strings and
  settings by their usual names and shapes, and a database configured some other way (a
  framework config file, say) can get past it.
- **Clones your project** into temporary per-instance workspaces under your OS temp directory and
  tears them down afterward (`--keep-workspaces` to inspect them). It never modifies your
  source files. It does write its reports and logs to `.twin/` in the project, links your
  dependency folders (`node_modules`, a Python virtualenv, `vendor`) into each workspace rather
  than copying them, and runs your `setup` command (if any) in the project itself.
- Runs a local HTTP proxy bound to loopback addresses only, for the lifetime of the run.
- **`twin clean` trusts the project's `.twin/` folder.** It reads the process ids earlier runs
  recorded there and stops those processes, after checking that each one's command line still
  matches what Twin started. Like `twin run`, only use it on projects you trust.

If you're running `twin run` in CI, treat it the same as any other step that executes your
application code: it has the same access to secrets/environment as the job it runs in.
