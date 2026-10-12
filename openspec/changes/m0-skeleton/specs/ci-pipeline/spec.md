# Spec Delta

## Purpose

Defines the automated quality gate that every pull request must pass, so regressions in style, types or unit behavior never reach the main branch.

## ADDED Requirements

### Requirement: PR quality gate
A CI workflow SHALL run on every pull request and on pushes to `main`, executing lint (ESLint incl. security rules and Prettier check), typecheck (`tsc --noEmit`) and unit tests, and SHALL fail if any of them fails (SPEC §15).

#### Scenario: Lint error fails the build
- **WHEN** a pull request introduces a file that violates an ESLint rule
- **THEN** the lint job fails and the workflow is reported as failed on the PR

#### Scenario: Green PR
- **WHEN** a pull request passes lint, typecheck and unit tests
- **THEN** the workflow is reported as successful

### Requirement: Strict TypeScript everywhere
Every project in the monorepo SHALL compile with `strict: true` and `noUncheckedIndexedAccess: true`, and explicit `any` SHALL be a lint error (SPEC §2, CLAUDE.md).

#### Scenario: Explicit any rejected
- **WHEN** a source file declares a parameter typed `any`
- **THEN** `pnpm lint` exits with a non-zero status

### Requirement: Local pre-commit checks
A pre-commit hook SHALL run formatting and lint on staged files so that most CI failures are caught before pushing.

#### Scenario: Unformatted file blocked
- **WHEN** a developer commits a staged file that is not Prettier-formatted
- **THEN** the hook formats it or aborts the commit with the offending file listed
