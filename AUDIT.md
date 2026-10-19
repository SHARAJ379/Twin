# Pre-release audit

Audit of the whole repository before releasing 0.1.1, done 2026-10-19 against `master` at
`4d5e264` ("Release 0.1.1"). Every file listed at the end was read in full and checked for
correctness, cross-platform behaviour, security, verdict honesty, code quality, tests and
docs. Every bug fix has a test that was run against the old code and failed, then passed
with the fix.

## Bugs fixed

The first four were found earlier the same day by running Twin against a real FastAPI app;
the rest in this audit.

| # | File | What was wrong | Test added | Commit |
| - | ---- | -------------- | ---------- | ------ |
| 1 | `src/domain/safetyScan.ts` | **Safety false negative.** A connection string whose password holds an unencoded `/`, `?` or `#` (`postgres://admin:p/ss@db.prod.example.com/app`) passed the real-database check: the host was read as `admin`. Twin would have written test data into that database. | `safetyScan.test.ts` (4 cases + a guard) | `5b01d87` |
| 2 | `src/domain/redaction.ts` | **Secret leak.** A JWT or key under an ordinary JSON or form field name (`{"data":{"login":"<JWT>"}}`, `{"result":"sk_live_..."}`) was written whole into `results.json`. | `redaction.test.ts` | `581016f` |
| 3 | `src/application/evaluate.ts` | **Wrong blame.** A step with no `check:` that passed on one instance but failed on two was reported as "fix the scenario" (exit 2). It's a real bug: now `instance-divergence` (exit 1), with suspects. | `evaluate.test.ts`, `traceFindings.test.ts` | `892bcb1` |
| 4 | `src/application/evaluate.ts` | **Over-counting.** An untagged step failing only because an earlier check had already caught the bug was reported as a second bug. | `evaluate.test.ts` | `bcc4b17` |
| 5 | `src/domain/stacks/php.ts` | **Laravel never booted.** `storage/` was left out of every workspace, and Laravel needs `storage/framework/views`. Every Laravel app got `E_BOOT_TIMEOUT` with a misleading hint. Reproduced with a Laravel-shaped app. | `runCommandAcceptance.php.test.ts` (Laravel-shaped app) | `e402c1f` |
| 6 | `src/infra/stack/virtualenvs.ts` (new), `loadSourceFiles.ts`, `run.ts` | A virtualenv not named `.venv`/`venv` (`.venv-backend`, 1.3 GB in the app it was found in) was copied into every workspace and scanned. | `virtualenvs.test.ts`, `loadSourceFiles.test.ts` | `b95f2c9` |
| 7 | `src/domain/safetyScan.ts`, `run.ts` | The "your database keeps what a run writes" note appeared for a database under `{{shared}}`, which Twin creates and deletes itself. | `safetyScan.test.ts`, `databaseNote.test.ts` (e2e) | `c7cb453`, `464791a` |
| 8 | `src/infra/stack/detectStack.ts`, `init.ts` | An app in a subfolder (`backend/`) got "could not tell what kind of project" with no direction. Now names the subfolder. | `detectStack.test.ts`, `init.test.ts` | `3325c86` |
| 9 | `src/domain/scenarioParser.ts`, `run.ts` | A misspelled `check:` was only reported after booting the app three times and running the scenario twice. Now rejected up front, at its line. | `scenarioParser.test.ts`, `run.test.ts` | `ac8f8c0` |
| 10 | `src/infra/config/loadTwinConfig.ts` | A `twin.config.json` saved "UTF-8 with BOM" (Windows PowerShell 5.1's `Out-File`) was rejected as invalid JSON. | `loadTwinConfig.test.ts` | `623d887` |
| 11 | `src/domain/sharedDisk.ts` | A stray `%` in a `sqlite:`/`file:` env path crashed the run with a bare "URI malformed". | `sharedDisk.test.ts` | `4d2fe5f` |
| 12 | `src/domain/jsonPath.ts` | `$.constructor`, `$.toString` on a body without them matched JavaScript built-ins instead of "did not match". | `jsonPath.test.ts` | `a786b17` |
| 13 | `src/cli/commands/doctor.ts` | `twin doctor` failed (exit 1) without git, which nothing in Twin uses. | `doctor.test.ts` (new) | `9268ece`, `a83f23a` |
| 14 | `src/report/terminal.ts`, `markdown.ts` | The BLOCKED note said "the session bug **above**" (it can be below) and "rejected **on another instance**" (false for `restart-persistence`, in every broken example's report). | `terminal.test.ts` | `b03eef4`, `2f54b6b` |
| 15 | `src/cli/commands/init.ts` | The starter `scenario.yaml` pointed users at `docs/scenario.schema.json`, a path that only exists in Twin's own repo. | `init.test.ts` | `5e90ca3` |
| 16 | `src/infra/build/runBuildCommand.ts`, `src/infra/process/runSetupCommand.ts` | A failing `build`/`setup` command's last lines (its actual error) could be missing from the output Twin shows: the log tail was read on `exit`, before the pipes drained. | `runBuildCommand.test.ts`, `runSetupCommand.test.ts` (`6f400da`) | `8f19cee` |

**How #16 was found:** my first local probe said "20/20 lost", but that came from a broken
probe (a heredoc mangled the child's script), so I retracted it: measured properly on
Windows it never happened (0 of 165 runs, up to 24 in parallel), and I left the code
alone and only added the two tests. On the first push, CI's Linux job failed both tests
(run 39222250425): the race is real on Linux and doesn't show on Windows. The fix then
went in, and those tests are its before/after proof.

## Cleanups and test improvements

- `twin clean` wasn't wrapped in the CLI's error handler like every other command; two
  stale comments (`RequestStep.via`, `SuspectKind`) (`d06b7c9`).
- `--help`: `--project` printed one machine's absolute path as its default; `--allow-remote`
  understated what's scanned and cited an internal id (`52f7c81`).
- CI workflow got an explicit read-only token (`8aa72a2`).
- The Python, Go, Ruby and PHP acceptance tests asserted only the exit code while their
  titles promised more; they now assert the report: one session bug, three BLOCKED,
  suspects present, and four passes for each fixed app (`464791a`).
- The scenario schema's `$id` now resolves, enabling editor autocomplete (`339d361`).
- Two comments point at the README's renamed Security section; npm keywords (`e2c253b`, `12851ee`).

## Docs updated

- **README.md** rewritten for beginners (`9f5c4fb`): what Twin is, install, a one-minute
  try with real output, use on your own app, result labels and exit codes, common
  problems. Install blocks and markers unchanged: the Install workflow's generated scripts
  are byte-identical for all 8 routes.
- **docs/** (new): `scenarios.md`, `configuration.md`, `ci.md`, `how-it-works.md`,
  `troubleshooting.md`. The rewrite corrected two errors in the old README: a missing
  `/health` route can't cause `E_BOOT_TIMEOUT` (any answer below 500 counts), and templates
  work in `request:` only.
- **SECURITY.md**: trust model corrected, "What counts as local" and redaction moved in.
- **action.yml**: `report-dir` description. **examples/README.md**: copy-pasteable commands.
- **CHANGELOG.md**: an Unreleased entry for each user-visible change.

### README outline

1. What is Twin?
2. Install (npm, npx, PowerShell tip)
3. Try it in 1 minute (broken-express, then fixed-express, with real output)
4. Use it on your app (5 numbered steps; database warning)
5. Reading the results (PASS / FAIL / BLOCKED / NOT PROVEN / ERROR; exit codes 0/1/2)
6. Common problems (6 rows; link to the full table)
7. Everything else (links into docs/ and SECURITY.md; install from source; unreleased)
8. Contributing, License

## Dependencies

- `npm audit`: 0 vulnerabilities.
- `npm outdated`: four majors are held back on purpose because they'd drop Node 20, which
  Twin supports (`commander` 15, `dependency-cruiser` 18; `typescript` 7 is blocked by
  typescript-eslint's peer range). Patch/minor updates are available for `eslint`,
  `typescript-eslint` and `vitest`, within their declared ranges; not taken during the
  release audit. Nothing is abandoned.

## Proposed, not done

These need a decision from you, or are bigger than a pre-release fix:

1. **Release numbering.** `package.json` says 0.1.1 and CHANGELOG has a dated
   `[0.1.1] - 2026-10-18` section, but 0.1.1 is untagged and everything above sits under
   `[Unreleased]`. Tagging this `master` as v0.1.1 would ship these fixes under a section
   that doesn't list them: either move them into 0.1.1 (and re-date it), or bump to 0.1.2.
2. **Very large projects.** Twin copies the whole project into a workspace per instance
   (plus a pristine copy) and hashes it twice per run. The FastAPI app this started with
   had a 92 GB `data/` folder at its root: about 370 GB of copying. A size warning or an
   ignore option (`"ignore": ["data"]`) needs a design choice.
3. **Python interpreter detection** only looks in `.venv`/`venv`. A venv under another
   name is now shared, but its interpreter isn't used for the guessed start command.
4. **Templates in `expect:`** (`bodyContains: "{{email}}"`) are taken literally. Rendering
   them is a behaviour change (and needs redaction of the rendered value in messages).
5. **Design-doc references.** 55 source files cite `TWIN_ARCHITECTURE.md`,
   `TWIN_CONTEXT.md`, `§7.5`, `I7` and similar, which aren't in the repository. Publish
   those docs, or reword roughly 150 comments.
6. **Pin third-party actions to commit SHAs** (`ruby/setup-ruby@v1`,
   `shivammathur/setup-php@v2`, and the `actions/*`); Dependabot already tracks them.
7. **`vitest.config.ts` coverage block** sets thresholds, but no coverage provider is
   installed and nothing runs it. Add `@vitest/coverage-v8` and a CI step, or remove it.
8. **A zero-setup demo.** The examples aren't in the npm package, so the README's
   one-minute try needs git. A `twin demo` command, or a dependency-free example, would
   remove that.
9. **Unused error codes** `E_CONTROL_FAILED`, `E_STEP_TIMEOUT`, `E_PROXY`, `E_INTERNAL`
   are declared but never thrown.

## Verification

All run locally on Windows 11 before pushing:

| Check | Result |
| ----- | ------ |
| `npm run lint`, `depcheck`, `typecheck`, `build` | all exit 0 |
| Full suite, Node 24.19.0, `--maxWorkers=2` | 85 files, 862 passed, 4 skipped, 0 failed |
| Full suite, Node 20.20.2, `--maxWorkers=2` | 85 files, 862 passed, 4 skipped, 0 failed |
| Skips | the same 4 POSIX-only tests both times (process groups, file modes); no toolchain was missing, every live Python/Go/Ruby/PHP/Flask test ran |
| All ten examples, as shipped, no flags | every `broken-*` exits 1 (1 session bug + 3 BLOCKED, suspects attached); every `fixed-*` exits 0 (4 passed) |
| `npm run pack:smoke` | 15 of 15 checks pass |
| `npm publish --dry-run` | 201 files: `LICENSE`, `README.md`, `package.json` and 198 under `dist/`; no tests, sources or examples |
| Fresh-user run | packed tarball installed globally into a throwaway prefix with spaces in its path; followed the README word for word: `twin doctor`, `--version`, `git clone --depth 1`, broken-express (exit 1), fixed-express (exit 0), then on a new app `twin init`, `twin run` (exit 2, "No checks ran"), the README's login scenario (exit 0), `twin report`, `twin report --format markdown`, `twin clean` - all as documented |
| README links | 65 relative links and anchors resolve (checker proven to catch a broken file and anchor); external links all 200, except npmjs.com, which blocks scripted clients (package confirmed with `npm view`) and `docs/scenarios.md` on GitHub, live after the push |
| README install blocks | the generated install script is byte-identical to before the rewrite for all 8 routes |

CI results after pushing are listed in the report that accompanies this file.

## File checklist (261 files)

Every file in `git ls-files` (260) plus the untracked, non-ignored ones (0), skipping only `node_modules`, `dist` and `.git`. Each was read in full; the note says what was found, or "OK".

### Root files (16)

- [x] `.dependency-cruiser.cjs`: OK
- [x] `.gitignore`: OK
- [x] `AUDIT.md`: this file
- [x] `CHANGELOG.md`: Unreleased entries added for every user-visible fix; README entry rewritten (9f5c4fb). Note: 0.1.1 is untagged - see Proposed
- [x] `CODE_OF_CONDUCT.md`: OK
- [x] `CONTRIBUTING.md`: OK - commands and policy match the repo
- [x] `LICENSE`: OK
- [x] `README.md`: rewritten for beginners; reference moved to docs/; install blocks byte-identical (9f5c4fb)
- [x] `SECURITY.md`: trust model corrected (--allow-remote-host, scan is a safety net, what Twin writes, twin clean trusts .twin/) (a8b7295); 'What counts as local' and redaction moved here from the README (9f5c4fb)
- [x] `action.yml`: report-dir description was wrong (a8b7295); inputs passed through env, so no injection - OK
- [x] `eslint.config.js`: OK
- [x] `package-lock.json`: OK - npm audit: 0 vulnerabilities
- [x] `package.json`: keywords (12851ee); engines >=20 matches every runtime dependency's floor - OK
- [x] `tsconfig.build.json`: OK
- [x] `tsconfig.json`: OK
- [x] `vitest.config.ts`: OK to run; coverage block has no provider installed and nothing runs it - see Proposed

### .github/ (3)

- [x] `.github/FUNDING.yml`: OK
- [x] `.github/dependabot.yml`: OK - the three ignored majors are the Node-20 conflicts
- [x] `.github/pull_request_template.md`: OK

### .github/ISSUE_TEMPLATE/ (3)

- [x] `.github/ISSUE_TEMPLATE/bug_report.yml`: OK
- [x] `.github/ISSUE_TEMPLATE/config.yml`: OK
- [x] `.github/ISSUE_TEMPLATE/feature_request.yml`: OK

### .github/workflows/ (4)

- [x] `.github/workflows/ci.yml`: no permissions block, so the default token (8aa72a2); actions pinned to major tags, not SHAs - see Proposed
- [x] `.github/workflows/codeql.yml`: OK - least privilege
- [x] `.github/workflows/install.yml`: OK - least privilege, every route checked, no step passes on failure
- [x] `.github/workflows/release.yml`: OK - OIDC, no token, tag/version check, post-publish verify

### docs/ (6)

- [x] `docs/ci.md`: new: GitHub Action and other CI (9f5c4fb)
- [x] `docs/configuration.md`: new: config, commands, exit codes (9f5c4fb)
- [x] `docs/how-it-works.md`: new: phases, what Twin touches, limitations, languages (9f5c4fb)
- [x] `docs/scenario.schema.json`: $id pointed at a URL that doesn't exist (339d361); matches src copy (tested)
- [x] `docs/scenarios.md`: new: scenario guide (9f5c4fb)
- [x] `docs/troubleshooting.md`: new: full troubleshooting; corrected the old /health row (9f5c4fb)

### scripts/ (2)

- [x] `scripts/packSmoke.mjs`: OK - ran green
- [x] `scripts/readmeInstall.mjs`: OK - all 8 routes extract identically before/after the README rewrite

### examples/ (1)

- [x] `examples/README.md`: commands weren't copy-pasteable (94ba228)

### examples/broken-express/ (6)

- [x] `examples/broken-express/package-lock.json`: OK
- [x] `examples/broken-express/package.json`: OK
- [x] `examples/broken-express/scenario-typo.yaml`: OK - exits 2 (tested)
- [x] `examples/broken-express/scenario.yaml`: OK
- [x] `examples/broken-express/server.js`: OK - binds 127.0.0.1; run: exit 1, 1 bug + 3 blocked
- [x] `examples/broken-express/twin.config.json`: OK

### examples/broken-go/ (4)

- [x] `examples/broken-go/go.mod`: OK
- [x] `examples/broken-go/main.go`: OK - binds 127.0.0.1; run: exit 1, 1 bug + 3 blocked
- [x] `examples/broken-go/scenario.yaml`: OK
- [x] `examples/broken-go/twin.config.json`: OK

### examples/broken-php/ (3)

- [x] `examples/broken-php/index.php`: OK - php -S 127.0.0.1; run: exit 1, 1 bug + 3 blocked
- [x] `examples/broken-php/scenario.yaml`: OK
- [x] `examples/broken-php/twin.config.json`: OK

### examples/broken-python/ (4)

- [x] `examples/broken-python/app.py`: OK - binds 127.0.0.1; run: exit 1, 1 bug + 3 blocked
- [x] `examples/broken-python/requirements.txt`: OK
- [x] `examples/broken-python/scenario.yaml`: OK
- [x] `examples/broken-python/twin.config.json`: OK

### examples/broken-ruby/ (3)

- [x] `examples/broken-ruby/app.rb`: OK - binds 127.0.0.1; run: exit 1, 1 bug + 3 blocked
- [x] `examples/broken-ruby/scenario.yaml`: OK
- [x] `examples/broken-ruby/twin.config.json`: OK

### examples/fixed-express/ (5)

- [x] `examples/fixed-express/package-lock.json`: OK
- [x] `examples/fixed-express/package.json`: OK
- [x] `examples/fixed-express/scenario.yaml`: OK
- [x] `examples/fixed-express/server.js`: OK - binds 127.0.0.1; run: exit 0, 4 passed
- [x] `examples/fixed-express/twin.config.json`: OK

### examples/fixed-go/ (4)

- [x] `examples/fixed-go/go.mod`: OK
- [x] `examples/fixed-go/main.go`: OK - binds 127.0.0.1; run: exit 0, 4 passed
- [x] `examples/fixed-go/scenario.yaml`: OK
- [x] `examples/fixed-go/twin.config.json`: OK

### examples/fixed-php/ (3)

- [x] `examples/fixed-php/index.php`: OK - php -S 127.0.0.1; run: exit 0, 4 passed
- [x] `examples/fixed-php/scenario.yaml`: OK
- [x] `examples/fixed-php/twin.config.json`: OK

### examples/fixed-python/ (4)

- [x] `examples/fixed-python/app.py`: OK - binds 127.0.0.1; run: exit 0, 4 passed
- [x] `examples/fixed-python/requirements.txt`: OK
- [x] `examples/fixed-python/scenario.yaml`: OK
- [x] `examples/fixed-python/twin.config.json`: OK

### examples/fixed-ruby/ (3)

- [x] `examples/fixed-ruby/app.rb`: OK - binds 127.0.0.1; run: exit 0, 4 passed
- [x] `examples/fixed-ruby/scenario.yaml`: OK
- [x] `examples/fixed-ruby/twin.config.json`: OK

### tests/e2e/ (18)

- [x] `tests/e2e/bootAndProxy.test.ts`: OK
- [x] `tests/e2e/cascadingSession.test.ts`: OK
- [x] `tests/e2e/databaseNote.test.ts`: {{shared}} case end to end (464791a)
- [x] `tests/e2e/fingerprintSalt.test.ts`: OK
- [x] `tests/e2e/flaskSecretKey.test.ts`: OK
- [x] `tests/e2e/goCompileChoice.test.ts`: OK
- [x] `tests/e2e/loopbackHost.test.ts`: OK
- [x] `tests/e2e/orphanCleanup.test.ts`: OK - fixed waits, but state is checked after each, so it fails loudly, never falsely
- [x] `tests/e2e/responseDivergence.test.ts`: OK
- [x] `tests/e2e/routingExercised.test.ts`: OK
- [x] `tests/e2e/runCommandAcceptance.go.test.ts`: asserted exit code only (464791a)
- [x] `tests/e2e/runCommandAcceptance.php.test.ts`: asserted exit code only (464791a); Laravel-shaped regression test (e402c1f)
- [x] `tests/e2e/runCommandAcceptance.python.test.ts`: asserted exit code only (464791a)
- [x] `tests/e2e/runCommandAcceptance.ruby.test.ts`: asserted exit code only (464791a)
- [x] `tests/e2e/runCommandAcceptance.test.ts`: OK - asserts report contents; comment repointed (9f5c4fb)
- [x] `tests/e2e/runScenario.test.ts`: OK
- [x] `tests/e2e/setupCommand.test.ts`: OK
- [x] `tests/e2e/sharedDisk.test.ts`: OK

### tests/e2e/helpers/ (3)

- [x] `tests/e2e/helpers/exampleReport.ts`: new shared assertions (464791a)
- [x] `tests/e2e/helpers/fixtureRequirements.ts`: OK
- [x] `tests/e2e/helpers/orphanManager.mjs`: OK

### tests/examples/ (1)

- [x] `tests/examples/bindAddress.test.ts`: OK

### tests/scripts/ (1)

- [x] `tests/scripts/readmeInstall.test.ts`: OK

### src/application/ (6)

- [x] `src/application/controlRun.test.ts`: OK
- [x] `src/application/controlRun.ts`: OK
- [x] `src/application/evaluate.test.ts`: tests for both fixes (892bcb1, bcc4b17)
- [x] `src/application/evaluate.ts`: a step failing only across two instances was a 'fix the scenario' error (892bcb1); a later consequence counted as a second bug (bcc4b17)
- [x] `src/application/splitRun.test.ts`: OK
- [x] `src/application/splitRun.ts`: OK

### src/checks/ (6)

- [x] `src/checks/builtInChecks.test.ts`: OK
- [x] `src/checks/dataConsistency.ts`: OK
- [x] `src/checks/fileConsistency.ts`: OK
- [x] `src/checks/index.ts`: OK
- [x] `src/checks/restartPersistence.ts`: OK
- [x] `src/checks/sessionSurvivesSwitch.ts`: OK

### src/cli/ (3)

- [x] `src/cli/index.ts`: clean unguarded (d06b7c9); --help text (52f7c81)
- [x] `src/cli/shutdown.test.ts`: OK
- [x] `src/cli/shutdown.ts`: OK

### src/cli/commands/ (10)

- [x] `src/cli/commands/clean.test.ts`: OK
- [x] `src/cli/commands/clean.ts`: OK
- [x] `src/cli/commands/doctor.test.ts`: new (9268ece)
- [x] `src/cli/commands/doctor.ts`: failed without git, which Twin never uses (9268ece, a83f23a)
- [x] `src/cli/commands/init.test.ts`: tests added (3325c86, 5e90ca3)
- [x] `src/cli/commands/init.ts`: subfolder hint (3325c86); starter scenario linked a repo-only path (5e90ca3)
- [x] `src/cli/commands/report.test.ts`: OK
- [x] `src/cli/commands/report.ts`: OK
- [x] `src/cli/commands/run.test.ts`: test added (ac8f8c0)
- [x] `src/cli/commands/run.ts`: wiring for the {{shared}}, virtualenv and check-id fixes (c7cb453, b95f2c9, ac8f8c0)

### src/domain/ (57)

- [x] `src/domain/authRejection.test.ts`: OK
- [x] `src/domain/authRejection.ts`: OK
- [x] `src/domain/bootDiagnosis.test.ts`: OK
- [x] `src/domain/bootDiagnosis.ts`: OK
- [x] `src/domain/check.ts`: OK
- [x] `src/domain/compiledBinary.test.ts`: OK
- [x] `src/domain/compiledBinary.ts`: OK
- [x] `src/domain/controlGate.test.ts`: OK
- [x] `src/domain/controlGate.ts`: OK
- [x] `src/domain/deploymentProfile.ts`: OK
- [x] `src/domain/envSources.test.ts`: OK
- [x] `src/domain/envSources.ts`: OK
- [x] `src/domain/errors.test.ts`: OK
- [x] `src/domain/errors.ts`: OK - E_CONTROL_FAILED, E_STEP_TIMEOUT, E_PROXY, E_INTERNAL are declared but never thrown; kept as the declared public surface
- [x] `src/domain/expectation.test.ts`: OK
- [x] `src/domain/expectation.ts`: OK
- [x] `src/domain/instance.ts`: OK
- [x] `src/domain/jsonPath.test.ts`: test added (a786b17)
- [x] `src/domain/jsonPath.ts`: $.constructor etc. matched built-ins (a786b17)
- [x] `src/domain/logRedaction.test.ts`: OK
- [x] `src/domain/logRedaction.ts`: OK
- [x] `src/domain/loopbackHost.test.ts`: OK
- [x] `src/domain/loopbackHost.ts`: OK
- [x] `src/domain/redaction.test.ts`: test added (581016f)
- [x] `src/domain/redaction.ts`: LEAK: JWT/known-prefix credentials under ordinary field names reached results.json (581016f)
- [x] `src/domain/relatedSteps.test.ts`: OK
- [x] `src/domain/relatedSteps.ts`: OK
- [x] `src/domain/responseDivergence.test.ts`: OK
- [x] `src/domain/responseDivergence.ts`: OK
- [x] `src/domain/responseFingerprint.ts`: OK
- [x] `src/domain/safetyScan.test.ts`: tests for both fixes (5b01d87, c7cb453)
- [x] `src/domain/safetyScan.ts`: FALSE NEGATIVE: password with / ? # hid a real host (5b01d87); {{shared}} database note (c7cb453); comments (e2c253b, 9f5c4fb)
- [x] `src/domain/saveExpression.test.ts`: OK
- [x] `src/domain/saveExpression.ts`: OK
- [x] `src/domain/scenario.ts`: stale comment on via: (d06b7c9)
- [x] `src/domain/scenarioParser.test.ts`: test added (ac8f8c0)
- [x] `src/domain/scenarioParser.ts`: misspelled check: only caught after a full run (ac8f8c0)
- [x] `src/domain/scenarioSchema.test.ts`: OK
- [x] `src/domain/scenarioSchema.ts`: $id (339d361)
- [x] `src/domain/scenarioTransform.test.ts`: OK
- [x] `src/domain/scenarioTransform.ts`: OK
- [x] `src/domain/sharedDisk.test.ts`: test added (4d2fe5f)
- [x] `src/domain/sharedDisk.ts`: stray % in an env path crashed the run (4d2fe5f)
- [x] `src/domain/shellQuote.test.ts`: OK
- [x] `src/domain/shellQuote.ts`: OK
- [x] `src/domain/stack.ts`: OK
- [x] `src/domain/stepResult.ts`: OK
- [x] `src/domain/suspect.ts`: stale 'tracer isn't built yet' comment (d06b7c9)
- [x] `src/domain/suspectRule.ts`: OK
- [x] `src/domain/template.test.ts`: OK
- [x] `src/domain/template.ts`: OK
- [x] `src/domain/twinConfig.test.ts`: OK
- [x] `src/domain/twinConfig.ts`: OK
- [x] `src/domain/verdict.test.ts`: OK
- [x] `src/domain/verdict.ts`: OK
- [x] `src/domain/workspaceDiff.test.ts`: OK
- [x] `src/domain/workspaceDiff.ts`: OK

### src/domain/stacks/ (7)

- [x] `src/domain/stacks/generic.ts`: OK
- [x] `src/domain/stacks/go.ts`: OK
- [x] `src/domain/stacks/index.ts`: OK
- [x] `src/domain/stacks/node.ts`: OK - dist/build not copied by design; documented in troubleshooting
- [x] `src/domain/stacks/php.ts`: Laravel couldn't boot: storage/ not copied (e402c1f)
- [x] `src/domain/stacks/python.ts`: OK - interpreter only found in .venv/venv; see Proposed
- [x] `src/domain/stacks/ruby.ts`: OK

### src/infra/artifacts/ (2)

- [x] `src/infra/artifacts/fsArtifactStore.test.ts`: OK
- [x] `src/infra/artifacts/fsArtifactStore.ts`: OK - lock design verified; --run <id> is local input

### src/infra/build/ (4)

- [x] `src/infra/build/prepareCompileOutput.test.ts`: OK
- [x] `src/infra/build/prepareCompileOutput.ts`: OK
- [x] `src/infra/build/runBuildCommand.test.ts`: new (6f400da); failed on Linux CI before the fix
- [x] `src/infra/build/runBuildCommand.ts`: log tail read before the pipes drained (8f19cee)

### src/infra/config/ (2)

- [x] `src/infra/config/loadTwinConfig.test.ts`: test added (623d887)
- [x] `src/infra/config/loadTwinConfig.ts`: UTF-8 BOM rejected as invalid JSON (623d887)

### src/infra/http/ (5)

- [x] `src/infra/http/cookieJar.test.ts`: OK
- [x] `src/infra/http/cookieJar.ts`: OK - a cookie without Path defaults to / (more permissive than RFC 6265; can't invent a divergence)
- [x] `src/infra/http/fingerprintSalt.ts`: OK
- [x] `src/infra/http/httpScenarioClient.test.ts`: OK
- [x] `src/infra/http/httpScenarioClient.ts`: OK - expect: isn't templated (now documented; see Proposed)

### src/infra/log/ (1)

- [x] `src/infra/log/consoleLogger.ts`: OK

### src/infra/process/ (17)

- [x] `src/infra/process/getCommandLine.test.ts`: OK
- [x] `src/infra/process/getCommandLine.ts`: OK
- [x] `src/infra/process/isProcessAlive.ts`: OK
- [x] `src/infra/process/killTree.test.ts`: OK
- [x] `src/infra/process/killTree.ts`: OK - on Windows a graceful stop is a hard kill (now documented)
- [x] `src/infra/process/logRingBuffer.ts`: OK
- [x] `src/infra/process/logSink.test.ts`: OK
- [x] `src/infra/process/logSink.ts`: OK
- [x] `src/infra/process/pidFile.ts`: OK
- [x] `src/infra/process/portAllocator.ts`: OK
- [x] `src/infra/process/processInstanceDriver.test.ts`: OK
- [x] `src/infra/process/processInstanceDriver.ts`: OK
- [x] `src/infra/process/reapOrphans.test.ts`: OK
- [x] `src/infra/process/reapOrphans.ts`: OK - trusts .twin/pids.json, verified by command line; documented in SECURITY.md
- [x] `src/infra/process/reapOrphansFailSafe.test.ts`: OK
- [x] `src/infra/process/runSetupCommand.test.ts`: new (6f400da); failed on Linux CI before the fix
- [x] `src/infra/process/runSetupCommand.ts`: log tail read before the pipes drained; reproduced on Linux CI only (8f19cee)

### src/infra/proxy/ (3)

- [x] `src/infra/proxy/httpProxy.test.ts`: OK
- [x] `src/infra/proxy/httpProxy.ts`: OK
- [x] `src/infra/proxy/httpProxyPortConflict.test.ts`: OK

### src/infra/safety/ (4)

- [x] `src/infra/safety/loadDotEnvFiles.test.ts`: OK
- [x] `src/infra/safety/loadDotEnvFiles.ts`: OK
- [x] `src/infra/safety/loadSourceFiles.test.ts`: test added (b95f2c9)
- [x] `src/infra/safety/loadSourceFiles.ts`: scanned non-standard virtualenvs (b95f2c9)

### src/infra/sharedDisk/ (1)

- [x] `src/infra/sharedDisk/snapshotPaths.ts`: OK - another program writing a data file in the temp dir can make passes NOT PROVEN (now documented; never a false pass)

### src/infra/stack/ (4)

- [x] `src/infra/stack/detectStack.test.ts`: test added (3325c86)
- [x] `src/infra/stack/detectStack.ts`: no hint when the app is in a subfolder (3325c86)
- [x] `src/infra/stack/virtualenvs.test.ts`: new (b95f2c9)
- [x] `src/infra/stack/virtualenvs.ts`: new: any pyvenv.cfg folder linked, not copied (b95f2c9)

### src/infra/workspace/ (4)

- [x] `src/infra/workspace/fsWorkspaceManager.test.ts`: OK
- [x] `src/infra/workspace/fsWorkspaceManager.ts`: comment (e402c1f); copies the whole project 3x per run - see Proposed
- [x] `src/infra/workspace/orphanWorkspaces.test.ts`: OK
- [x] `src/infra/workspace/orphanWorkspaces.ts`: OK

### src/ports/ (6)

- [x] `src/ports/artifactStore.ts`: OK
- [x] `src/ports/instanceDriver.ts`: OK
- [x] `src/ports/logger.ts`: OK
- [x] `src/ports/proxy.ts`: OK
- [x] `src/ports/scenarioClient.ts`: OK
- [x] `src/ports/workspaceManager.ts`: OK

### src/report/ (13)

- [x] `src/report/evidenceLedger.test.ts`: OK
- [x] `src/report/evidenceLedger.ts`: OK
- [x] `src/report/exitCode.test.ts`: OK
- [x] `src/report/exitCode.ts`: OK
- [x] `src/report/fixPrompt.test.ts`: OK
- [x] `src/report/fixPrompt.ts`: OK
- [x] `src/report/markdown.test.ts`: OK
- [x] `src/report/markdown.ts`: same as terminal.ts (b03eef4, 2f54b6b)
- [x] `src/report/reportJson.test.ts`: OK
- [x] `src/report/reportJson.ts`: OK
- [x] `src/report/terminal.test.ts`: tests added (b03eef4, 2f54b6b)
- [x] `src/report/terminal.ts`: BLOCKED note: 'above' and 'another instance' could be false (b03eef4, 2f54b6b)
- [x] `src/report/verdictSummary.ts`: OK

### src/tracer/ (9)

- [x] `src/tracer/findDynamicSuspects.test.ts`: OK
- [x] `src/tracer/findDynamicSuspects.ts`: OK
- [x] `src/tracer/findStaticSuspects.test.ts`: OK
- [x] `src/tracer/findStaticSuspects.ts`: OK
- [x] `src/tracer/sourceFiles.ts`: OK
- [x] `src/tracer/sourceLines.ts`: OK
- [x] `src/tracer/staticRules.test.ts`: OK
- [x] `src/tracer/traceFindings.test.ts`: test added (892bcb1)
- [x] `src/tracer/traceFindings.ts`: suspects for instance-divergence (892bcb1)
