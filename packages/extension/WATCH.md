# Chrome watch builds

Run `pnpm dev:extension:prod` from the repository root to watch extension source
changes while using the live API. Load `packages/extension/dist-prod` unpacked
in Chrome. If already installed, click Reload once after starting the first
watch build to activate automatic reload.

Successful builds trigger reload within about a second. Chrome may close the
popup; reopen it to see changes. This is full extension reload, not React Fast
Refresh: unsaved UI state can be lost. Account storage persists. Timer actions
still affect your real account on the live API.

`pnpm dev:extension` watches the local API target in `packages/extension/dist`.
Run the local backend separately for that target.

The watcher follows this checkout. Worktree changes appear after integration.
Shared packages imported from compiled output need rebuilding separately.

Only watch builds contain reload code. It polls a local revision file and keeps
the development worker awake without new permissions or a listening server.
To restore normal worker sleep, stop the watcher, run
`pnpm build:extension:prod`, and reload once in Chrome.
