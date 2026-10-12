# Contributing

Thanks for considering a contribution to Twin.

## Getting started

```bash
npm install
npm run verify   # lint + dependency-cruiser + typecheck + build + test
```

Some e2e tests boot real fixture apps as child processes. Those suites **skip themselves**
when what they need isn't installed, printing a `[skip]` line saying why - so a bare clone
runs green without every toolchain on your machine.

To actually run them:

```bash
npm ci --prefix examples/broken-express   # the Node fixtures
npm ci --prefix examples/fixed-express
```

plus `go`, `ruby`, `php`, and `python` on your PATH for the `examples/*-go`, `*-ruby`,
`*-php`, and `*-python` fixtures.

In CI those same guards **fail** instead of skipping: CI installs every toolchain
deliberately, so a missing one means the workflow is broken, and skipping would turn that
into a green run that verified nothing - the exact failure mode Twin exists to catch.

## Before opening a PR

- `npm run verify` passes.
- New behavior has a test. New stack support gets a real fixture app
  (`examples/broken-<stack>` / `examples/fixed-<stack>`) and an e2e acceptance test, not just
  unit-tested detection/tracer rules - see the existing `examples/*` pairs for the pattern.
- If you changed the scenario schema, update `docs/scenario.schema.json` too.

## Versioning

Twin is pre-1.0 (`0.x`): the CLI's flags, exit codes, `twin.config.json` fields, and the
scenario YAML schema may still change between minor versions. Breaking changes are called out
in [CHANGELOG.md](CHANGELOG.md). 1.0 will mean those surfaces are considered stable and follow
semver from then on.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/SHARAJ379/Twin/issues). For security issues, see
[SECURITY.md](SECURITY.md) instead - please don't file those publicly.
