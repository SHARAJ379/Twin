# Troubleshooting

When your app fails to start, Twin prints the last lines of its own output under the
error. They usually say exactly what's wrong. Each copy's full output is in
`.twin/runs/<id>/logs/`.

## Your app doesn't start

| What you see | Why | What to do |
| --- | --- | --- |
| `E_BOOT_CRASH`, and the log says `Cannot find module .../dist/...` | your app needs building first; Twin copies your project but not built output like `dist/` | add `--build "npm run build"`, or `"build"` in `twin.config.json` |
| `E_BOOT_CRASH`, "exited (exit code 0) instead of serving" | the start command finished without leaving a server running | the log says why. If it starts the server in the background, run it in the foreground |
| `E_BOOT_DETACHED` | the start command handed the server to something else and exited (`pm2 start`, `--daemon`) | run it in the foreground (`pm2-runtime start`, no daemon flag), and stop the leftover server yourself |
| `E_BOOT_TIMEOUT`, but the app works when you start it yourself | Twin waits until `/health` answers with any status below `500`, and it kept answering `500` or more: often a health check that tests something the copy can't reach, like a database | point Twin at a route that answers once the app is up: `--health-path /` or `"healthPath": "/"`. A missing route (`404`) is fine: it counts as started |
| `E_BOOT_TIMEOUT`, "is listening on port N, not on port M" | your app ignores `PORT` and picks its own port | make it read `PORT`, use `--port-env <the variable it reads>`, or put `{{port}}` in `--start` |
| `E_BOOT_TIMEOUT`, "it printed nothing at all" | the app was still starting, often compiling (`ts-node`, a custom `go run`) | move the compiling into `--build`, which isn't timed, or raise `--boot-timeout-ms` |
| Python `ModuleNotFoundError` | the start command used a `python` without your project's packages | let Twin find your `.venv` or `venv`, or put your virtualenv's `python` in `--start` (with its full path if it's outside the project) |

## Twin won't start a run

| What you see | Why | What to do |
| --- | --- | --- |
| `E_UNSAFE_ENV` | your app is configured to use what looks like a real, remote database | use a local one. If you're sure this one is safe for test data: `--allow-remote-host <host>`. The error names the host and where it was set |
| `E_NO_STACK` | Twin doesn't recognise the project, or can't tell how to start it | if the hint names a subfolder (`"backend" looks like a Python project`), run Twin there. Otherwise pass `--start "<command>"` |
| `E_AMBIGUOUS_STACK` | the folder looks like two languages | say which one serves HTTP: `--stack node` |
| `E_SCENARIO_INVALID` | the scenario has a mistake | the message gives the line and what to change. A misspelled `check:` lists the four real ones |
| `E_CONFIG_INVALID` | `twin.config.json` has a mistake | the message names the field |
| `E_LOCKED` | another Twin run is in progress in this project, or one was killed | wait for it. If you're sure none is running: `twin clean` (or `twin clean --unlock`) |
| PowerShell: "running scripts is disabled on this system" | Windows PowerShell blocks npm's `twin.ps1` launcher | run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or type `twin.cmd` instead of `twin` |

## The result surprises you

| What you see | Why | What to do |
| --- | --- | --- |
| `scenario-ran-as-written` (error, exit `2`) | a step failed even on a single copy, so the scenario doesn't work yet | fix that step's path or `expect:`. The message names the step and what it got |
| `instance-divergence` (fail, exit `1`) | a step worked on one copy and failed on two | a real bug, not a scenario mistake. The message names the step |
| "No checks ran" (exit `2`) | no step has a `check:` | add `check:` to the step that reads data back through the other copy |
| NOT PROVEN (exit `2`) | both copies wrote to a file outside their own folders, which they only share because they're on one machine | keep that data somewhere every server can reach. If the path really is shared in production, see [Storage both copies share](configuration.md#storage-both-copies-share) |
| BLOCKED | a login stopped working on the other copy, so this check was refused before it could test anything | fix the session bug in the same report, then run again |
| `request timed out after 30000ms` | the app never answered that route, or streams a response that never ends | raise `--request-timeout-ms` if it's just slow. Streams and WebSockets aren't supported as steps |
| `"as: x" is not a declared client` | a step uses a user that isn't in the scenario's `clients:` list | add it to `clients:`, or fix the typo |
| Windows Firewall asks "allow public and private networks to access this app?" | your app listens on every network interface | harmless: Cancel is fine. To stop it, have your app listen on `127.0.0.1` (see [The port your app listens on](configuration.md#the-port-your-app-listens-on)) |
| Nothing is wrong with your app, but a run left processes or folders behind | it crashed or was killed | `twin clean` |
