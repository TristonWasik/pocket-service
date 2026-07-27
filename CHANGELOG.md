# Changelog

## 1.1.1 - 2026-07-27

### Changed

- Updated runtime and tooling constraints:
  - node engines requirement to >=24
  - packageManager pin to pnpm@11.17.0
- Hardened GitHub workflows for modern pnpm/Corepack behavior:
  - disabled interactive Corepack download prompts in CI/publish workflows
  - ensured workflows continue using pinned v7 action commit SHAs
- Improved CI reliability for integration tests by setting a workspace-local MongoDB binary cache path in workflow test steps.

### Fixed

- Fixed pnpm workspace build policy configuration by setting valid allowBuilds booleans for esbuild and mongodb-memory-server.

## 1.1.0 - 2026-07-26

### Added

- Added expanded unit coverage for split service helpers:
  - api helper tests
  - config helper tests
  - lifecycle helper tests
  - shutdown helper tests
  - workers helper tests
- Added integration coverage for worker route auth behavior:
  - default header fallback enabled path
  - default header fallback disabled path
- Added publish safeguards in package scripts:
  - prepublishOnly
  - pack:check

### Changed

- Refactored internal service helper layout under src/core/service for clearer separation of concerns.
- Restructured tests into tests/unit and tests/integration.
- Tightened package metadata and publish surface:
  - corrected ESM entry/type paths to dist output
  - restricted published files to dist, README, and LICENSE
  - added repository/bugs/homepage/keywords/engines metadata
  - set scoped package publish access to public
- Improved worker thread entry resolution in service workers runtime.

### Notes

- Public import surface remains package-root based:
  - import from @twasik4/pocket-service
