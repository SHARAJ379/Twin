# Contributing

Thanks for considering a contribution to Twin.

## Getting started

```bash
npm install
npm run build
npm link         # makes your working copy's `twin` available on your PATH
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
- If you changed anything about what gets packaged (`files`, `bin`, the build output,
  dependencies), run `npm run pack:smoke` - it packs the tarball, installs it into a clean
  project and drives the installed binary, which `npm run verify` can't tell you anything
  about.

## Releasing

Publishing is tag-driven. Bump the version in `package.json`, move the changes under a new
`CHANGELOG.md` heading, then push a matching tag (`v0.2.0`): `.github/workflows/release.yml`
verifies the tag agrees with `package.json`, runs the pack smoke test, and publishes to npm
with provenance. It authenticates through npm trusted publishing: the package's settings on
npmjs.com name this repository's `release.yml` as its publisher, so no npm token is stored
anywhere. Then it installs the published version from npm on clean Linux and Windows
runners and runs it.

## Versioning

Twin is pre-1.0 (`0.x`): the CLI's flags, exit codes, `twin.config.json` fields, and the
scenario YAML schema may still change between minor versions. Breaking changes are called out
in [CHANGELOG.md](CHANGELOG.md). 1.0 will mean those surfaces are considered stable and follow
semver from then on.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/SHARAJ379/Twin/issues). For security issues, see
[SECURITY.md](SECURITY.md) instead - please don't file those publicly.
