## Summary

<!-- What does this PR change and why? Link the issue / 007resort-docs spec. -->

## Type

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] chore / refactor / test / ci

## Checklist

- [ ] Title follows Conventional Commits (`feat: ...`, `fix: ...`)
- [ ] No payment, inventory, pricing or transition-validation logic in the KDS (the API decides)
- [ ] Status changes are _requested_ via the API; the board only reflects server events
- [ ] Every mutating request sends an `Idempotency-Key` (UUID)
- [ ] Timestamps kept in UTC; localised only for display
- [ ] No secrets or `.env` files committed
- [ ] `npm run typecheck`, `lint`, `test`, `build` pass locally
- [ ] Tests added/updated
- [ ] Screenshots attached for UI changes

## Notes for reviewers
