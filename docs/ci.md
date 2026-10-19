# Using Twin in CI

Twin's exit code is the result: `0` safe, `1` found a bug, `2` couldn't tell. So any CI
system can run `twin run` and fail the job on a non-zero exit.

## GitHub Actions

Twin ships as a GitHub Action ([action.yml](../action.yml)). It installs your project's
dependencies, runs `twin run`, and exposes the result:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4 # the Node your app runs on (Twin needs 20 or later)
  with:
    node-version: 22
- uses: SHARAJ379/Twin@v0.1.1
  with:
    project-dir: .
```

Pin a release tag (or a full commit SHA), not `@master`: the branch moves, and a CI job
that silently changes behaviour is worse than one that needs a bump.

### Inputs

| Input                | What it does                                                                                         | Default |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| `project-dir`        | the folder to test, relative to the workflow's working directory                                      | `.`     |
| `scenario`           | path to `scenario.yaml`                                                                              | `twin.config.json`'s `scenario` |
| `start`, `build`, `setup` | same as the `--start`, `--build` and `--setup` flags                                            | from `twin.config.json` |
| `health-path`, `port-env`, `boot-timeout-ms`, `request-timeout-ms` | same as the matching flags                      | Twin's defaults |
| `allow-remote`       | `true` to run even if a real database is configured                                                   | `false` |
| `fail-on-finding`    | fail the job when Twin finds a bug (exit `1`). Exit `2` always fails it                               | `true`  |
| `install`            | how to install your project's dependencies: `auto` (from your lockfile: `npm ci`, yarn, pnpm, pip into `.venv`, `bundle install`, `composer install`, `go mod download`), `none`, or a command of your own | `auto` |
| `node-version`       | set up this Node first. Leave it empty to use the Node already on `PATH`                             | empty   |

### Outputs

| Output       | What it is                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `exit-code`  | Twin's exit code: `0`, `1` or `2`                                                              |
| `report-dir` | the run's report folder, `<project-dir>/.twin/runs/<id>`, ready for `actions/upload-artifact`  |

To keep the report when a run finds something:

```yaml
- uses: SHARAJ379/Twin@v0.1.1
  id: twin
  with:
    fail-on-finding: "false"
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: twin-report
    path: ${{ steps.twin.outputs.report-dir }}
```

## Other CI systems

Install Twin and run it like you would locally. `twin report --format markdown` prints the
last report again, for a job summary:

```bash
npm install -g @sharaj379/twin
twin run
```

In CI, Twin has the same access to secrets as the job it runs in. See
[SECURITY.md](../SECURITY.md).
