# Publishing the Raycast extension

This file is for maintainers and is not part of the store copy. The extension is developed in the Track Your Time monorepo, in `packages/raycast`. The store copy is exported into `packages/raycast/store`, a gitignored folder, and published from there.

**The code under `src/vendor/` is generated.** `scripts/vendor-core.mjs` copies it from `packages/core` and `packages/shared`, because the store installs the extension with `npm ci` and cannot resolve workspace packages. Never edit `src/vendor/`. Change `packages/core` or `packages/shared`, then run `pnpm vendor:raycast`. `scripts/vendor-core.test.mjs` fails when the copy is out of date.

1. Export the store copy from the monorepo root. The Raycast Store requires the MIT license and your Raycast username:

   ```bash
   pnpm export:raycast --license MIT --author <raycast-username> --lint --build
   ```

   This writes `packages/raycast/store` (gitignored), runs `npm install` to create `package-lock.json`, runs `ray lint`, and builds into a temporary directory. Pass a directory after `export:raycast` to export somewhere else. The export refuses to run without `--author` and `--license`. `--draft` writes a copy without them, for inspection only, because `ray lint` and `publish` reject it.

   Two decisions come before the first export. The author must be your real Raycast Store username: `ray lint` checks it against `raycast.com/api/v1/users/<name>`, and `name` and `author` cannot change after release. The store copy, including the files under `src/vendor/` that come from `packages/core` and `packages/shared`, is published under MIT.

   The export also changes three things in the copy only. `src/lib/local-defaults.ts` is set to `false`, so `npm run dev` in the export uses the hosted service when **API URL** and **Web App URL** are empty. The headers of the files under `src/vendor/`, `.prettierignore` and the comment in `eslint.config.js` no longer name monorepo scripts.

2. Commit your work in the monorepo, then publish from the export directory:

   ```bash
   git status                         # must show nothing to commit
   cd packages/raycast/store
   npx @raycast/api@latest publish
   ```

   No separate git repository is needed. `publish` checks two things: that it runs inside a git work tree, and that `git status` shows no changed or untracked files. `packages/raycast/store` is a gitignored folder of the monorepo, so both hold once the monorepo is committed. `publish` copies the folder, without `.git`, `node_modules` and `raycast-env.d.ts`, into its own clone of the `raycast/extensions` fork in Raycast's config directory. It commits, tags and pushes there, never in the monorepo. It also sends the monorepo's `origin` URL and commit, so the store listing links to this repository. If you export to a directory outside any git repository, run `git init` and commit there first. The export prints that step when it applies.

   It signs in to GitHub and opens a draft pull request against `raycast/extensions`. Before you mark the pull request ready for review, add this to its description:

   - The extension needs a Track Your Time account. Reviewers can create one at https://trackyourtime.dev/signup, or ask for test credentials, which you send privately and never put in the pull request.
   - Leave **API URL** and **Web App URL** empty to use the hosted service. `npm run dev` uses the hosted service too.
   - Sign-in: run **Timer**, choose **Sign in to Track Your Time**, and approve the code on the page that opens in the browser.
   - `src/vendor/` is copied from the Track Your Time repository, where the other Track Your Time clients use the same code. Changes to it belong there.

3. If a reviewer changes the pull request, `publish` refuses until you pull those changes. **Never run `pull-contributions` inside the monorepo.** It runs `git pull` and `git merge` in the directory it starts in, which puts merge commits on the monorepo's branch. Pull into a throwaway repository instead:

   ```bash
   tmp=$(mktemp -d) && rsync -a --exclude node_modules --exclude .git packages/raycast/store/ "$tmp/"
   (cd "$tmp" && git init -q && git add -A && git commit -qm export && npx @raycast/api@latest pull-contributions)
   diff -ru -x .git -x node_modules packages/raycast/store "$tmp"
   ```

   Port the diff into `packages/raycast` by hand, then export and publish again. Port changes under `src/vendor/` into `packages/core` or `packages/shared` instead, and run `pnpm vendor:raycast`.

For local development, run `pnpm dev:raycast` from the monorepo root. Under `ray develop`, empty **API URL** and **Web App URL** use `http://localhost:5159` and `http://localhost:3392`.

The export does not keep that: it sets `src/lib/local-defaults.ts` to `false`, so `npm run dev` there uses `https://api.trackyourtime.dev` and `https://trackyourtime.dev` when both preferences are empty. `scripts/export-store.test.mjs` checks both halves.

## Store screenshots

`metadata/` is empty until you take these. `ray lint` does not require screenshots, but store review expects them for an extension with view commands. Take them before the first publish.

The store takes up to six PNG screenshots at 2000×1250 in `metadata/`, named `trackyourtime-1.png` to `trackyourtime-6.png`. Put nothing else in `metadata/`. Take every shot from seeded demo data, never from a real account.

1. Pick three free ports in the range 49152 to 65535. Check each one with `lsof -i :<port>`. Then start a local stack from the monorepo root and note its process id:

   ```bash
   API_PORT=<api> PORT=<web> DOCS_PORT=<docs> INSTANCE_ID=raycast-shots pnpm run dev
   curl -s http://127.0.0.1:<api>/api/health
   ```

   MongoDB must run on `127.0.0.1:27017`. Redis and mail are optional.

2. Seed the demo account shortly before you take the shots, because the running timer and today's entries are relative to now:

   ```bash
   node scripts/marketing/seed-demo.mjs http://127.0.0.1:<api> http://localhost:<web>
   ```

   The script prints the email and password of an invented account, Maya Lindgren. The account has three clients, four projects, six tasks, three tags, about 25 weekdays of entries, two favorites and a timer that started 47 minutes ago.

3. Run `pnpm dev:raycast`. This replaces any development copy of the extension that Raycast already has, including its stored session and preferences.

4. In Raycast, open Extensions → Track Your Time. Set **API URL** to `http://localhost:<api>` and **Web App URL** to `http://localhost:<web>`. For the **Timer Menu Bar** command, set **Menu Bar Title** to "Description and Duration" and turn on **Clock**.

5. Open **Timer**. The signed-out screen opens Sign In, and the browser opens `http://localhost:<web>/app/device`. Sign in there as the seeded account and approve the code.

6. Set one appearance for every shot, light or dark. In Raycast Settings → Advanced, give **Window Capture** a hotkey (for example ⌘⇧⌥M) and turn on **Save to Metadata**.

7. Take the shots in this order, because the second one stops the running timer:

   | File | View | State |
   |---|---|---|
   | `trackyourtime-1.png` | **Timer** | The seeded timer runs. Stop Timer is the primary action. Favorites and Continue show below it. |
   | `trackyourtime-2.png` | **Show All Time** | Entries over several days, with the action panel (⌘K) open on one entry. |
   | `trackyourtime-3.png` | **Log Past Time…** (⌘⇧N in Timer) | A meeting from earlier today, with project, task and a tag set. |
   | `trackyourtime-4.png` | **Edit Entry…** (⌘E on a Continue row) | An entry with a task and tags. |
   | `trackyourtime-5.png` | **Start New Timer…** (⌘N) | Stop the timer first. The Project dropdown is open and grouped by client. |
   | `trackyourtime-6.png` | **Pick a Past Description…** (⌘⇧D in a form) | The description list, taken with Window Capture. Do not composite a menu bar region screenshot onto a canvas: store CI compares the background of every image and rejects one that differs. |

   Never show **Account and Session…** (⌘⇧A). It shows the account email and server.

8. Check the files:

   ```bash
   sips -g pixelWidth -g pixelHeight packages/raycast/metadata/*.png
   ```

   Every file must be 2000×1250, and there must be no more than six.

9. Clean up:
   - Stop the `pnpm run dev` process by its process id.
   - Stop `ray develop`.
   - Drop the database with `mongosh --quiet mongodb://127.0.0.1:27017/trackyourtime-dev-raycast-shots --eval 'db.dropDatabase()'`.
   - In Raycast, sign out and clear **API URL** and **Web App URL**.
   - Run `pnpm dev:raycast` again from your usual checkout.
