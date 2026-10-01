# Chrome live development

## Popup HMR (recommended)

From the repository root, run `pnpm hmr:extension`. This starts Vite and CRXJS on
a checked, random high port bound to loopback, with the live API as the backend.
Load `packages/extension/dist-prod` unpacked in Chrome. If it is already loaded,
click Reload once after starting HMR to switch from the static/watch build.

Keep the popup open while editing React components or CSS. React Fast Refresh
updates compatible components in place, preserving inputs and navigation.
CSS changes apply without a page reload. Changing hook order, replacing a
component, or editing a module without a valid refresh boundary can reset state.
Background-worker and manifest changes require a full extension reload; Chrome
may close the popup and clear session-only sign-in. Reopen the web app to reconnect.
Timer actions still affect your real account on the live API.

Choose the backend with the same command:

```sh
pnpm hmr:extension                                      # live API
pnpm hmr:extension --backend local                      # localhost:5159
pnpm hmr:extension --backend http://127.0.0.1:54321       # custom local port
pnpm hmr:extension --backend https://api.example.com     # another backend
```

`--local` and the existing `pnpm hmr:extension:local` are local-target shortcuts.
Explicit flags override `VITE_API_URL`; without flags that environment variable
can still supply a custom origin. Use `pnpm hmr:extension --help` for usage.
Only HTTP(S) origins are accepted, without credentials, paths, queries, or fragments.

Loopback backends use `packages/extension/dist` and the development identity;
remote backends use `packages/extension/dist-prod` and the store identity.
Start local backends separately. A custom backend must trust the extension origin;
`pnpm extension:id dev` or `pnpm extension:id prod` prints it. Self-hosted remote
servers use password or device sign-in; the web bridge remains limited to the
existing trusted web origins.

These options set the **build default**. A server previously chosen in the popup
still takes precedence: use **Change server** there to switch an existing install.
This preserves the normal account-switch and unsent-change checks.

The HMR config follows core/shared source edits directly for their root exports.
Shared subpath exports still use compiled output and need rebuilding when changed.

Do not run HMR and build-watch commands for the same output folder together.
The server must remain running while using the HMR extension. Restarting it can
choose a new port: reload the extension once after a restart. HMR follows this
checkout; separate worktree changes appear after integration into this checkout.

HMR uses a separate config and CRXJS's development-only loader. Production and
Firefox release commands retain their original build pipeline. To return to a
standalone extension, stop HMR, run `pnpm build:extension:prod`, and reload Chrome's
extension once. Never package or upload an HMR output directory.

## Full rebuild and reload

`pnpm dev:extension:prod` watches the live API target; `pnpm dev:extension` watches
the local API target. Both rebuild files and reload the entire extension after a
successful build, rather than preserving popup state. Activate with one manual
Chrome reload after starting the first watch build. These builds poll a local
revision file and keep the worker awake. Restore a normal production build and
reload once to remove that development behavior.
