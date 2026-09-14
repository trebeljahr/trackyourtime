import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { organization } from "better-auth/plugins/organization";
import { MongoClient } from "mongodb";
import { env, getTrustedOrigins } from "../config/env.js";
import { mongooseRowStore } from "../services/account-deletion/stores.js";
import { isEmailDeliveryConfigured, sendEmail } from "../services/email.js";
import {
  authBeforeHook,
  organizationPluginOptions,
} from "../services/membership/organization-lockdown.js";
import { accountDeletionOptions } from "./account-deletion.js";
import {
  emailVerificationOptions,
  sweepSocketsAfterRevocation,
  twoFactorPlugin,
  type AuthMail,
} from "./account-security.js";
import { passwordResetEmail } from "../services/transactional-email.js";
import { preferredLocale } from "../services/user-locale.js";
import { DEVICE_FLOW_CLIENT_IDS } from "./client-label.js";
import { createPersonalWorkspace } from "./personal-workspace.js";
import {
  clientKindForNewSession,
  expiryForNewSession,
  expiryForSessionRefresh,
} from "./session-hooks.js";
import {
  SESSION_UPDATE_AGE_SECONDS,
  TOKEN_CLIENT_SESSION_SECONDS,
} from "./session-lifetime.js";

/**
 * Put an auth link in the server log.
 *
 * Two callers per send site, and both matter. With no transport configured
 * this line *is* the delivery mechanism — the documented way back into a
 * single-user instance whose owner locked themselves out. With a transport
 * that is configured but broken (SMTP_HOST set and EMAIL_FROM missing is the
 * easy mistake, wrong credentials the next one) the send throws, and without
 * this the one recovery path is removed by exactly the misconfiguration that
 * needs it. The throw is still propagated — a silent delivery failure is the
 * worse outcome — the URL just goes to the log on the way out.
 */
function logAuthUrl(label: string, recipient: string, url: string): void {
  console.log(`[auth] ${label} URL for ${recipient}: ${url}`);
}

/** Sweep sockets whose session is gone, without a static import cycle. */
function sweepRevokedSockets(): void {
  void import("../ws/handler.js")
    .then(({ revokeStaleSockets }) => revokeStaleSockets())
    .catch(() => undefined);
}

/**
 * better-auth instance. Must be initialized AFTER mongoose.connect() because
 * it uses the same MongoDB URI.
 *
 * We create a separate MongoClient (not from mongoose) to avoid the type
 * mismatch between mongoose's bundled mongodb driver and better-auth's.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any = null;
let _authClient: MongoClient | null = null;

export async function initAuth(): Promise<void> {
  _authClient = new MongoClient(env.MONGODB_URI);
  await _authClient.connect();
  const db = _authClient.db();

  _auth = betterAuth({
    database: mongodbAdapter(db),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: getTrustedOrigins(),

    emailAndPassword: {
      enabled: true,
      /**
       * Only when mail can actually be delivered: a self-host with no
       * transport would otherwise lock every new account out behind a link
       * that only reaches the server log. Accounts made before this was on
       * are marked verified by `scripts/backfill-email-verified.ts` — run it
       * once after the deploy that configures mail (docs/deploy.md).
       */
      requireEmailVerification: isEmailDeliveryConfigured(),
      async sendResetPassword({
        user,
        url,
      }: {
        user: { id: string; email: string };
        url: string;
      }) {
        // Branch on whether *any* transport is configured, never on one
        // provider's variables: a Listmonk-shaped check would log the reset
        // URL and return on a self-host that has SMTP set up perfectly well,
        // leaving the user waiting for mail nobody ever tried to send. With
        // no transport at all the URL in the server log is the documented
        // recovery path for a locked-out admin.
        if (!isEmailDeliveryConfigured()) {
          logAuthUrl("Password reset", user.email, url);
          return;
        }
        try {
          const locale = await preferredLocale([user.id]);
          await sendEmail({ to: user.email, ...passwordResetEmail(locale, url) });
        } catch (error) {
          logAuthUrl("Password reset", user.email, url);
          throw error;
        }
      },
    },

    /**
     * Sign-up, sign-in-while-unverified and change-email links. better-auth
     * reads `sendVerificationEmail` from THIS block only; under
     * `emailAndPassword` it was never called. See `auth/account-security.ts`.
     */
    emailVerification: emailVerificationOptions(
      async (url: string, mail: AuthMail) => {
        if (!isEmailDeliveryConfigured()) {
          logAuthUrl("Verification", mail.to, url);
          return;
        }
        try {
          await sendEmail(mail);
        } catch (error) {
          logAuthUrl("Verification", mail.to, url);
          throw error;
        }
      },
      // The recipient's explicit preference; English when there is none.
      (userId) => preferredLocale([userId]),
    ),

    user: {
      /**
       * Settings → Account → Change email. The new address gets a
       * verification link and the email changes only when it is followed.
       */
      changeEmail: { enabled: true },

      /**
       * Settings → Delete account, as `POST /api/auth/delete-user`. Everything
       * trackyourtime owns is removed in `beforeDelete`, before better-auth removes
       * the user and every session; shared workspaces lose only this person's
       * rows. The password rule and the retry story are in
       * `auth/account-deletion.ts`.
       */
      deleteUser: accountDeletionOptions({
        context: () => getAuth().$context,
        appRows: mongooseRowStore,
        /**
         * Every session is gone by now, so HTTP is already refused on every
         * device. Sweeping at once closes the sockets too, instead of leaving
         * them streaming until the next minute's re-check.
         */
        onDeleted: () => {
          void import("../ws/handler.js")
            .then(({ revokeStaleSockets }) => revokeStaleSockets())
            .catch(() => undefined);
        },
      }),
    },

    hooks: {
      /**
       * One `before` hook for the whole instance, so each step is a plain
       * call in a fixed order:
       *
       *  1. `/organization/*` over HTTP answers 404. The plugin's endpoints
       *     write only its own tables, never `WorkspaceMember`, and accept
       *     roles like "admin,owner"; membership is driven through tRPC.
       *     See `services/membership/organization-lockdown.ts`.
       *  2. `/delete-user` remembers whether a password was sent.
       */
      before: authBeforeHook,
      /** "Sign out other devices" closes their sockets now, not in a minute. */
      after: sweepSocketsAfterRevocation(sweepRevokedSockets),
    },

    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
    },

    session: {
      /**
       * The **ceiling**, not the answer: thirty days, which is what a token
       * client (mobile, desktop, Raycast, the extension, the CLI) gets.
       * Browser cookie sessions are cut back to seven by the `session` hooks
       * below, which rewrite `expiresAt` on create and on every refresh.
       *
       * Why the global has to be the long one rather than the short one — the
       * refresh trigger is computed against it — is argued in
       * `auth/session-lifetime.ts`. Read that before changing either number.
       */
      expiresIn: TOKEN_CLIENT_SESSION_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
      /**
       * `client` is what turns the raw session list into a readable
       * "Devices" screen. `input: false` keeps it out of the request body —
       * it is filled in by the databaseHooks below, from the request, so a
       * caller cannot write it directly.
       */
      additionalFields: {
        client: {
          type: "string",
          required: false,
          defaultValue: "unknown",
          input: false,
        },
      },
    },

    plugins: [
      /**
       * TOTP + backup codes. MUST stay ahead of `bearer()`: after-hooks run in
       * registration order, and the bearer hook running first would hand out
       * `set-auth-token` for the password session two-factor then deletes.
       * `auth/account-security.ts` has the rest, and
       * `tests/two-factor-integration.test.ts` pins the order.
       */
      twoFactorPlugin(),

      /**
       * Lets any non-browser client (Raycast, the extensions, the desktop and
       * mobile shells) sign in normally and then carry its session as
       * `Authorization: Bearer <token>` instead of a cookie.
       *
       * Two token forms reach us and both must work: password sign-in returns
       * the *signed* token on the `set-auth-token` response header, while the
       * device flow returns the *raw* session token as `access_token` and
       * sets no such header. `requireSignature` would accept only the first
       * and break every device-paired client, so it stays off — which costs
       * nothing, because an unsigned value is signed with this server's own
       * secret and then looked up: an unknown token simply matches no session.
       */
      bearer(),

      /**
       * Workspaces. One organization IS one trackyourtime workspace — the plugin
       * owns identity, membership, invitations and roles as TABLES, while
       * `workspaceId` on the domain collections is what actually scopes data.
       *
       * Its HTTP endpoints are closed (the `before` hook above answers 404 to
       * every `/organization/*` request). Invitations, role changes, removal,
       * leaving and ownership transfer go through the tRPC routers, which
       * write this plugin's `member`/`invitation` rows AND the app's
       * `WorkspaceMember` — see `services/membership/`. So there is no
       * `sendInvitationEmail` here: the plugin never sends one.
       *
       * `teams` stays OFF deliberately. The plugin's teams are a SECOND
       * nesting level inside an organization; trackyourtime's ownership scope is
       * one level deep. Enabling it would put two scope ids in every query and
       * two pickers in every UI — including a 360px extension popup — for a
       * grouping nobody has asked for. `teamId` is additive if that changes.
       */
      // Options (creator role, no organization deletion, invitation
      // lifetime) live beside the lockdown, so the integration test runs the
      // same ones.
      organization(organizationPluginOptions),

      /**
       * RFC 8628 device flow, for clients where typing a password is wrong:
       * Raycast and the CLI show a short code, the user approves it at
       * /device in an already-signed-in browser.
       */
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        /**
         * The code is approved in the *web app*, which is a different origin
         * from this API in dev and in any split deployment. Without this,
         * better-auth points the user at the API's own /device, which does
         * not exist.
         */
        verificationUri: `${env.FRONTEND_URL.replace(/\/$/, "")}/device`,
        validateClient: (clientId: string) =>
          Object.hasOwn(DEVICE_FLOW_CLIENT_IDS, clientId),
      }),
    ],

    databaseHooks: {
      user: {
        create: {
          /**
           * Give every new user their personal workspace immediately, so the
           * "user with no workspace" state never exists and no resolver needs
           * a branch for it.
           *
           * Deliberately non-fatal: a signup must not fail because the
           * workspace could not be created. `ensurePersonalWorkspace` repairs
           * the gap on the next read.
           */
          after: async (user: { id: string; name?: string; email?: string }) => {
            await createPersonalWorkspace(getAuth().api, user);
          },
        },
      },

      session: {
        create: {
          /**
           * Stamp each new session with the client that created it, and give
           * it that client's session window.
           *
           * The stamp is what lets the devices list say "Raycast" rather than
           * guessing from a user agent that non-browser clients barely set,
           * and it is cosmetic. The window is not: `expiresAt` here is what
           * makes a browser session seven days and a phone's thirty, since
           * better-auth's `session.expiresIn` is one global number. See
           * `auth/session-lifetime.ts`.
           */
          before: async (session, context) => {
            const client = clientKindForNewSession(context);
            return {
              data: {
                ...session,
                client,
                expiresAt: expiryForNewSession(context),
              },
            };
          },
        },
        update: {
          /**
           * Keep a refreshed session on its own window.
           *
           * Without this the split above would last exactly one refresh:
           * better-auth re-expires a session to the *global* `expiresIn`
           * (`api/routes/session.mjs`), so a seven-day browser row would come
           * back as thirty the first time the browser was used — scoped in
           * appearance, global in behaviour.
           *
           * The client is read off the session row, not off the request that
           * triggered the refresh; `auth/session-hooks.ts` says why. Updates
           * that are not moving `expiresAt` — the organization plugin writing
           * the active workspace, say — are left untouched.
           */
          before: async (update, context) => {
            const expiresAt = expiryForSessionRefresh(update, context);
            return expiresAt ? { data: { ...update, expiresAt } } : undefined;
          },
        },
      },
    },
  });
}

export function getAuth() {
  if (!_auth) {
    throw new Error(
      "Auth not initialized. Call initAuth() after database connection.",
    );
  }
  return _auth;
}

export async function disconnectAuth(): Promise<void> {
  if (_authClient) {
    await _authClient.close();
    _authClient = null;
  }
}
