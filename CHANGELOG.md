# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project is pre-1.0, so the
public CLI surface (flags, exit codes, `twin.config.json` fields, scenario schema) may still
shift between minor versions.

## [Unreleased]

### Added

- `SECURITY.md` documenting the trust model and vulnerability reporting process.
- CodeQL static analysis and Dependabot (npm + GitHub Actions) in CI.
- `npm audit` gate in CI for production dependencies.
- Python joins Node.js, Go, Ruby and PHP as end-to-end validated against a real
  running app (`examples/broken-python` / `examples/fixed-python`, stdlib
  `http.server`, no pip dependencies) with a CI-enforced e2e acceptance test -
  all five supported stacks now have the same live-validation coverage.

### Changed

- Package renamed to `@sharaj379/twin` on npm (the unscoped `twin` and `twin-cli` names were
  already taken); the CLI binary itself is still invoked as `twin` after install.

## [0.1.0]

Initial feature set: `twin init` / `twin run` / `twin report` / `twin doctor` / `twin clean`,
CONTROL/SPLIT/EVALUATE/TRACE/REPORT pipeline, the four built-in checks
(`session-survives-switch`, `data-consistency`, `file-consistency`, `restart-persistence`),
and stack support for Node.js, Python, Go, Ruby and PHP - with Node, Go, Ruby and PHP each
validated end-to-end against real running example apps in CI.
