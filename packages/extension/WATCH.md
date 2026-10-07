# Chrome live development

## Popup HMR (recommended)

From the repository root, run `pnpm hmr:extension`. This starts Vite and CRXJS on
a checked, random high port bound to loopback, with the local API as the backend.
Load `packages/extension/dist-hmr` unpacked in Chrome. It appears as **Track Your
Time (dev)** with an purple clock wearing a yellow hard hat. Its ID, sign-in, and storage are
separate from production. Keep the store install or unpacked `dist-prod` alongside
it. Store and unpacked production share one identity; choose one for that slot.

Keep the popup open while editing React components or CSS. React Fast Refresh
updates compatible components in place, preserving inputs and navigation.
CSS changes apply without a page reload. Changing hook order, replacing a
component, or editing a module without a valid refresh boundary can reset state.
Background-worker and manifest changes require a full extension reload; Chrome
may close the popup and clear session-only sign-in. Reopen the web app to reconnect.
With `--backend live`, timer actions affect your real account on the live API.

Choose the backend with the same command:

```sh
pnpm hmr:extension                                      # local API
pnpm hmr:extension --backend live                       # live API (requires dev ID trust)
pnpm hmr:extension --backend local                      # localhost:5159
pnpm hmr:extension --backend http://127.0.0.1:54321       # custom local port
pnpm hmr:extension --backend https://api.example.com     # another backend
```

`--local` and the existing `pnpm hmr:extension:local` are local-target shortcuts.
Explicit flags override `VITE_API_URL`; without flags that environment variable
can still supply a custom origin. Use `pnpm hmr:extension --help` for usage.
Only HTTP(S) origins are accepted, without credentials, paths, queries, or fragments.

Every HMR backend uses `packages/extension/dist-hmr` and a development identity.
Start local backends separately. A custom backend must trust the extension origin;
`pnpm extension:id hmr` prints it. The local dev launcher trusts this ID
automatically. Remote servers, including the live API, must explicitly trust it
in `TRUSTED_ORIGINS`; the production ID’s trust does not apply. Self-hosted remote
servers use password or device sign-in; the web bridge remains limited to the
existing trusted web origins.

These options set the **build default**. A server previously chosen in the popup
still takes precedence: use **Change server** there to switch an existing install.
This preserves the normal account-switch and unsent-change checks.

The HMR config follows core/shared source edits directly for their root exports.
Shared subpath exports still use compiled output and need rebuilding when changed.

HMR and standalone builds use separate output folders. Run only one HMR server
per checkout.
The server must remain running while using the HMR extension. While it is
stopped, the loaded extension logs a refused `ws://localhost:<port>/?token=…`
WebSocket and `TypeError: Failed to fetch` on Chrome's Errors page: that is
Vite's client looking for its server, not the app. The port is remembered in
`packages/extension/.cache/hmr-port` and reused on restart, so the extension
reconnects on its own; reload it only when that port was taken and the server
printed a new one. Clear the Errors page afterwards — Chrome keeps old entries. HMR follows this
checkout; separate worktree changes appear after integration into this checkout.

HMR uses a separate config and CRXJS's development-only loader. Production and
Firefox release commands retain their original build pipeline. For a standalone
extension, run `pnpm build:extension:prod` and load `dist-prod`,
or use the store version. Neither depends on HMR. Never package HMR output.

### Moving from the old shared folder

Stop the old HMR command before rebuilding `dist-prod`. Restart HMR with this
configuration, then load `dist-hmr` as a new unpacked extension. Rebuild `dist-prod`
and reload the existing production extension once. Keep its storage intact: it
may contain unsent changes. The dev extension signs in independently.

## Full rebuild and reload

`pnpm dev:extension:prod` watches the live API target; `pnpm dev:extension` watches
the local API target. Both rebuild files and reload the entire extension after a
successful build, rather than preserving popup state. Activate with one manual
Chrome reload after starting the first watch build. These builds poll a local
revision file and keep the worker awake. Restore a normal production build and
reload once to remove that development behavior.
