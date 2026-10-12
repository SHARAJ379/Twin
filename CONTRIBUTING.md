# Contributing

Thanks for considering a contribution to Twin.

## Getting started

```bash
npm install
npm run verify   # lint + dependency-cruiser + typecheck + build + test
```

Some e2e tests boot real example apps as child processes:

```bash
npm ci --prefix examples/broken-express
npm ci --prefix examples/fixed-express
```

A handful of e2e tests also boot real Go/Ruby/PHP fixture apps (`examples/*-go`,
`examples/*-ruby`, `examples/*-php`) - install `go`, `ruby`, and `php` locally to run those too,
or skip them (`npx vitest run --exclude "**/*.go.test.ts" --exclude "**/*.ruby.test.ts" --exclude "**/*.php.test.ts"`).
CI always runs the full suite with all toolchains installed.

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
