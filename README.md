<div align="center">

# Twin

**Runs two copies of your app and shows you where they disagree.**

[![CI](https://github.com/SHARAJ379/Twin/actions/workflows/ci.yml/badge.svg)](https://github.com/SHARAJ379/Twin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@sharaj379/twin)](https://www.npmjs.com/package/@sharaj379/twin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

[Install](#install) · [Try it](#try-it-in-1-minute) · [Use it on your app](#use-it-on-your-app) · [Reading the results](#reading-the-results) · [Common problems](#common-problems) · [Docs](#everything-else)

</div>

## What is Twin?

When your app runs on two servers instead of one, things like logins and file uploads
can quietly break: a user logs in on one server, and the other has never heard of them.
**Twin runs two copies of your app on your computer and tells you what breaks, and how to
fix it.**

It works with apps written in **Node.js, Python, Go, Ruby and PHP**.

## Install

You need [Node.js](https://nodejs.org) 20 or later. The same commands work in a macOS or
Linux terminal and in Windows PowerShell:

<!-- install-check: npm posix powershell -->
```bash
npm install -g @sharaj379/twin
twin doctor   # checks your machine can run it
```

`twin doctor` prints a line per check, with a ✓ on each one that passes.

Or run Twin without installing it:

<!-- install-check: npx posix powershell -->
```bash
npx @sharaj379/twin doctor
```

With npx, type `npx @sharaj379/twin` wherever this page says `twin`.

> [!TIP]
> If PowerShell says "running scripts is disabled on this system", run
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or type `twin.cmd`
> instead of `twin`.

## Try it in 1 minute

Twin comes with small example apps. This one is broken on purpose: it keeps logins in
memory, so a second copy of it can't see them. You'll need git, and the same commands
work in PowerShell:

```bash
git clone --depth 1 https://github.com/SHARAJ379/Twin.git
cd Twin/examples/broken-express
npm ci
twin run
```

Twin starts the app once, then twice, sends the same requests to both, and prints this
(shortened here):

```text
✗ FAIL    session-survives-switch
  logged in via one instance, but the follow-up authenticated request via another instance was rejected (status 401)
  likely cause: server.js:19  const sessions = {}; // sessionId -> { email }  (medium confidence)

  Fix prompt (paste into Claude Code):
    My app has a likely bug at server.js:19 (const sessions = {}; // sessionId -> { email }) causing ...

✗ BLOCKED data-consistency
  the read-back via another instance never reached any record: it was rejected with status 401. ...
  blocked: rejected (401/403), so this check never reached what it tests - the session bug in this report is the cause, not a separate one

✗ BLOCKED file-consistency
  ...

✗ BLOCKED restart-persistence
  ...

1 bug found (session-survives-switch); 3 checks couldn't be tested because of it (data-consistency, file-consistency, restart-persistence) - this app is NOT safe to run on more than one instance.
```

**FAIL** means it works with one copy of the app but breaks with two: a real bug. Twin
pointed at the line that causes it (`server.js:19`, the in-memory `sessions`) and wrote a
fix prompt you can paste into an AI coding assistant. **BLOCKED** means a check couldn't
run because of that bug: once logins work, those get tested too. Now try the same app
with the bug fixed:

```bash
cd ../fixed-express
npm ci
twin run
```

This time every check passes (shortened again):

```text
✓ PASS    session-survives-switch
✓ PASS    data-consistency
✓ PASS    file-consistency
✓ PASS    restart-persistence

4 of 4 checks passed - this app looks safe to run on more than one instance.
```

There's a broken and a fixed app for every language in [examples/](examples/README.md).

## Use it on your app

**1. Open a terminal in your app's folder:** the one with its `package.json`,
`requirements.txt`, `go.mod`, `Gemfile` or `composer.json`.

**2. Set Twin up:**

```bash
twin init
```

This works out what language your app is in and how to start it, and writes two files:
`twin.config.json` (how to start your app) and `scenario.yaml` (what to test). It also adds
Twin's `.twin/` report folder to your `.gitignore`.

**3. Check Twin can start your app:**

```bash
twin run
```

The starter `scenario.yaml` only calls `GET /health`, so this run tests nothing yet. It
ends with `No checks ran` and exit code `2`. That's expected: it proves Twin can start
your app and talk to it. (If your app has no `/health` route, that step fails instead,
with a `scenario-ran-as-written` error. Step 4 replaces it anyway.)

**4. Describe what to test.** Replace `scenario.yaml` with requests that change something
through one copy and read it back through the other. For an app with a login:

```yaml
name: login-flow
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

This logs in on copy **A**, then asks copy **B** who's logged in. `check:` says what this
step proves. Use your app's real paths and fields. [Writing scenarios](docs/scenarios.md)
explains every option and the four checks.

**5. Run it again:**

```bash
twin run
```

> [!IMPORTANT]
> **Twin sends real requests, so your app writes real data.** If your app uses a
> database, the users and records each run creates stay there. Point Twin at a test
> database, or set a `setup` command that resets one before each run. See
> [Your database keeps what a run writes](docs/configuration.md#your-database-keeps-what-a-run-writes).
> Twin refuses to run at all if your app is configured to use what looks like a real,
> remote database.

## Reading the results

Each check gets one of these labels:

| Label          | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| **PASS**       | It works the same with two copies as with one.                                                       |
| **FAIL**       | It works with one copy but breaks with two. That's a bug in your app. Twin shows the likely line and a fix prompt. |
| **BLOCKED**    | This check couldn't run because of another problem in the same report, usually a login that broke. Fix that one and run again. |
| **NOT PROVEN** | It passed, but only because both copies used the same file on your computer. Two real servers wouldn't share it. |
| **ERROR**      | Twin couldn't judge: the scenario didn't work even with one copy, or the step wasn't really tested. The message says why. |

The run ends with an **exit code**, which is what CI looks at:

| Exit code | Meaning                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `0`       | Safe: at least one check passed, and nothing failed.                           |
| `1`       | Twin found a bug.                                                              |
| `2`       | Twin couldn't tell: something didn't work, or nothing was checked at all.      |

Each run is saved in `.twin/runs/` in your project. `report.md` there has the full report
with fix prompts. `twin report` prints the last one again.

## Common problems

| What you see | What to do |
| --- | --- |
| `E_BOOT_CRASH` | Your app stopped while starting. Read the app's own output that Twin prints underneath. If it says a module or `dist/` file is missing, your app needs building first: add `--build "npm run build"`. |
| `E_BOOT_TIMEOUT` | Your app didn't answer in time. If it ignores the `PORT` Twin gives it, make it read `PORT`. If `/health` answers with an error, use another route: `--health-path /`. |
| `E_NO_STACK` | Twin couldn't tell how to start your app. If it names a subfolder (like `backend`), run Twin there. Otherwise pass `--start "<your start command>"`. |
| `E_UNSAFE_ENV` | Your app is set up to use a real, remote database. Point it at a local or test one. |
| `scenario-ran-as-written` | A step failed even with one copy: check its path and `expect:` in `scenario.yaml`. |
| `No checks ran` | Add `check:` to the step that reads data back through the other copy. |

More in [Troubleshooting](docs/troubleshooting.md).

## Everything else

- **[Writing scenarios](docs/scenarios.md):** every step option, the four checks,
  saving values, multiple users, retries.
- **[Configuration and commands](docs/configuration.md):** `twin.config.json`, every
  command and flag, ports, shared storage, exit codes.
- **[Using Twin in CI](docs/ci.md):** the GitHub Action and other CI systems.
- **[How it works](docs/how-it-works.md):** what Twin does step by step, what it touches,
  supported languages, and what it can't see.
- **[Troubleshooting](docs/troubleshooting.md):** every error and what to do about it.
- **[Security](SECURITY.md):** Twin runs your app's own start command, unsandboxed. Read
  this before using it in CI or on someone else's project. Reports and logs have secrets
  masked before they're written.

<details>
<summary><strong>Install from source</strong></summary>

<br>

macOS / Linux:

<!-- install-check: source posix -->
```bash
git clone https://github.com/SHARAJ379/Twin.git
cd Twin
npm install
npm run build
npm install -g .
twin doctor
```

Windows (PowerShell):

<!-- install-check: source powershell -->
```powershell
git clone https://github.com/SHARAJ379/Twin.git
cd Twin
npm install
npm run build
npm install -g .
twin doctor
```

`npm install -g .` links the global `twin` to that folder, so keep the folder. To
update, run `git pull`, `npm install` and `npm run build` in it. npm 11 and later may
warn that some install scripts were blocked. That's expected: `npm run build` has
already built Twin.

</details>

<details>
<summary><strong>Try the latest unreleased version</strong></summary>

<br>

To try what's on `master` before it's released, without cloning:

<!-- install-check: unreleased posix powershell -->
```bash
npx --allow-git=all github:SHARAJ379/Twin doctor
```

It builds Twin on the way in (a minute or two) and needs git. npm 12 won't fetch a
package from git without `--allow-git`; older npm versions accept the flag too.
`npm install -g github:SHARAJ379/Twin` doesn't work: npm builds a package fetched from git
inside the global install, where Twin's build tools aren't installed.

</details>

CI runs every install command on this page, word for word, on clean Linux and Windows
machines with npm 10, 11 and 12, on every push and weekly.

## Contributing

Contributions are welcome. Setup, running the tests and the versioning policy are in
[CONTRIBUTING.md](CONTRIBUTING.md). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Sharaj R Shetty
