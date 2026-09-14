# Summary

<!-- What does this change do? One or two sentences is usually enough. -->

## Motivation

<!--
Why is this change worth making? What problem does it solve?
Link the issue it addresses, if there is one:

Closes #123
-->

## Type of change

<!-- Tick everything that applies. -->

- [ ] Bug fix (`fix:`) — a non-breaking change that fixes an issue
- [ ] New feature (`feat:`) — a non-breaking change that adds behaviour
- [ ] Refactor (`refactor:`) — no change in behaviour
- [ ] Tests (`test:`)
- [ ] Documentation (`docs:`)
- [ ] Build, tooling or dependencies (`chore:`)
- [ ] Breaking change — existing behaviour, data or configuration changes

## How this was tested

<!--
Which commands you ran, and what you did by hand. Name the client surface you
exercised (web app, browser extension, Raycast, server). If you added tests,
say what they cover.
-->

- [ ] `pnpm run build`
- [ ] `pnpm run test:unit`
- [ ] `pnpm run test:client`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test:e2e` (optional — needs Docker)
- [ ] Tested manually:

## Checklist

- [ ] I have signed off my commits (`git commit -s`) per the [DCO](https://developercertificate.org/)
- [ ] My commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), first line under 72 characters
- [ ] `pnpm run typecheck`, `pnpm run build`, `pnpm run test:unit` and `pnpm run test:client` pass locally
- [ ] I have added or updated tests covering the change, or explained above why none are needed
- [ ] I have updated the documentation where behaviour changed (`README.md`, `CLAUDE.md`, `docs/`, `docs-site/`)
- [ ] This pull request is focused on one concern
- [ ] I have read [CONTRIBUTING.md](https://github.com/trebeljahr/trackyourtime/blob/main/CONTRIBUTING.md)

<!--
Not signed off yet?

  Last commit only:   git commit --amend -s --no-edit
  Whole branch:       git rebase --signoff main

Then: git push --force-with-lease
-->
