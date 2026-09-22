# Contributing to 007resort-kds

## Branches

`main` is protected; all changes go through pull requests.

| Prefix      | Use for                   |
| ----------- | ------------------------- |
| `feature/*` | new functionality         |
| `fix/*`     | bug fixes                 |
| `docs/*`    | documentation only        |
| `chore/*`   | tooling, CI, dependencies |

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):
`feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`, `refactor: ...`,
`test: ...`, `ci: ...`. PR titles follow the same format.

## Pull requests

- Target `main`; keep PRs small and focused.
- CI must be green (typecheck, lint, format, test, build, secret scan).
- Fill in the PR template checklist.

## Client rules (non-negotiable)

1. **The API is authoritative.** The KDS contains no payment, inventory,
   pricing or transition-validation logic. It displays routed tickets and
   _requests_ transitions; the API validates and records staff + timestamps.
2. **Display state only.** `src/state` applies server events; it never invents
   state the server has not confirmed (no optimistic status changes without
   reconciliation).
3. **Idempotency:** every mutating request sends an `Idempotency-Key` UUID
   (handled by `ApiClient`). Reuse the same key when retrying the same action.
4. **Time:** timestamps from the API are UTC; localise only for display.
5. **Money** (if ever displayed) comes from the API as decimal strings and is
   shown as-is - never parsed to `number` for arithmetic.
6. **No secrets** in the repo or in `VITE_*` variables. CI runs gitleaks.

## Code style

- TypeScript `strict` plus extra checks (see `tsconfig.json`).
- ESLint flat config with `typescript-eslint` strict + stylistic type-checked
  rules; `npm run lint` must pass with zero warnings.
- Prettier: `npm run format`.
- No UI framework or new runtime dependency without an agreed decision in
  007resort-docs.
- Add or update vitest tests with every change.
