import nodemailer, { type Transporter } from "nodemailer";
import type { Locale } from "@starter/shared";
import { env } from "../config/env.js";
import { serverT } from "../i18n/index.js";

export interface EmailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailTransportKind = "smtp" | "listmonk" | "console";

/** The subset of the environment that decides how mail leaves this server.
 *  Declared as its own shape so the selection can be unit-tested without a
 *  process env, a socket or a database. */
export interface EmailTransportEnv {
  SMTP_HOST: string;
  EMAIL_FROM: string;
  LISTMONK_URL: string;
  LISTMONK_API_USER: string;
  LISTMONK_API_TOKEN: string;
  LISTMONK_TX_TEMPLATE_ID: string;
  LISTMONK_FROM_EMAIL: string;
  LISTMONK_FROM: string;
}

/**
 * Which transport a given environment selects, in a fixed order:
 *
 *   1. SMTP      — whenever SMTP_HOST is set. First, deliberately: a host
 *                  typed into SMTP_HOST is an explicit choice, and silently
 *                  preferring a Listmonk left over from an earlier setup
 *                  would send mail through a service the operator thought
 *                  they had replaced.
 *   2. Listmonk  — only when its whole set is present. A partial Listmonk
 *                  config is a misconfiguration, not a transport; treating
 *                  it as one turns every send into a 401 at delivery time.
 *   3. console   — no mail provider at all. Sends are logged, not delivered,
 *                  which is right for local dev and is the state a fresh
 *                  self-host boots in.
 *
 * Note that EMAIL_FROM does NOT participate: an SMTP host with no From
 * address must still select SMTP and then fail loudly at send time, because
 * falling back to console logging would look like "email is not configured"
 * to an operator who plainly configured it.
 */
export function selectEmailTransport(source: EmailTransportEnv): EmailTransportKind {
  if (source.SMTP_HOST.trim()) return "smtp";

  const listmonkReady =
    source.LISTMONK_URL &&
    source.LISTMONK_API_USER &&
    source.LISTMONK_API_TOKEN &&
    source.LISTMONK_TX_TEMPLATE_ID &&
    (source.LISTMONK_FROM_EMAIL || source.LISTMONK_FROM);
  return listmonkReady ? "listmonk" : "console";
}

/** The From address for an SMTP send. EMAIL_FROM wins; the Listmonk sender is
 *  accepted as a fallback so an instance migrating off Listmonk keeps sending
 *  from the identity its recipients already recognise. Empty means unset —
 *  the SMTP branch turns that into a thrown error rather than a guess. */
export function resolveFromAddress(source: EmailTransportEnv): string {
  return (
    source.EMAIL_FROM || source.LISTMONK_FROM || source.LISTMONK_FROM_EMAIL || ""
  );
}

/** Implicit TLS (SMTPS) or STARTTLS. SMTP_SECURE overrides; unset follows the
 *  port, 465 being the only implicit-TLS port in practice. */
export function resolveSmtpSecure(secure: string, port: number): boolean {
  const explicit = secure.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return port === 465;
}

/**
 * True when a send would actually be delivered rather than logged. Callers
 * that want to skip the email entirely (auth.ts logs a reset URL to the
 * server log instead) should branch on this rather than on any one provider's
 * variables — a Listmonk-shaped check silently ignores a configured SMTP host.
 */
export function isEmailDeliveryConfigured(): boolean {
  return selectEmailTransport(env) !== "console";
}

// Lazily constructed and memoized, the same shape as storage.ts's getS3():
// an unconfigured server must never build a transport, and a configured one
// should keep a single pooled connection rather than reconnecting per email.
let _transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!_transporter) {
    const port = Number.parseInt(env.SMTP_PORT, 10) || 587;
    _transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: resolveSmtpSecure(env.SMTP_SECURE, port),
      // Only offer credentials when there are credentials. Passing
      // { user: "", pass: "" } makes nodemailer attempt AUTH and fail against
      // a relay that does not want any.
      ...(env.SMTP_USER
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
        : {}),
    });
  }
  return _transporter;
}

/**
 * Send a transactional email.
 *
 * Three transports, chosen by selectEmailTransport(): plain SMTP (the
 * default, and all a self-host needs), Listmonk's /api/tx endpoint (opt-in,
 * used by the hosted deploy, which relays through its SES identity), or a
 * console log when neither is configured.
 *
 * Delivery failures throw. A password reset that fails silently is the worst
 * outcome here — the user waits for mail that was never sent, and the log
 * says nothing — so both real transports surface the provider's own error.
 */
export async function sendEmail(params: EmailParams): Promise<void> {
  switch (selectEmailTransport(env)) {
    case "smtp":
      return sendViaSmtp(params);
    case "listmonk":
      return sendViaListmonk(params);
    case "console":
      console.log(`[email] Would send to ${params.to}: ${params.subject}`);
      return;
  }
}

async function sendViaSmtp(params: EmailParams): Promise<void> {
  const from = resolveFromAddress(env);
  if (!from) {
    throw new Error(
      `Cannot send to ${params.to}: SMTP_HOST is set but EMAIL_FROM is not. ` +
        `Set EMAIL_FROM to an address ${env.SMTP_HOST} is allowed to send from.`,
    );
  }

  try {
    await getTransporter().sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      ...(params.html ? { html: params.html } : {}),
    });
  } catch (error) {
    // The underlying error is usually the only thing that identifies the
    // problem (bad credentials, TLS mismatch, relay refusing the From), so
    // it is kept verbatim alongside the host and port it was talking to.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SMTP send to ${params.to} via ${env.SMTP_HOST}:${env.SMTP_PORT} failed: ${reason}`,
      { cause: error },
    );
  }
}

/**
 * Listmonk's transactional endpoint. The template seeded by `hatchkit add
 * <project> listmonk-ses` renders `{{ .Tx.Data.subject }}` for the subject
 * and `{{ .Tx.Data.body }}` raw in the body (tx templates use Go
 * text/template — no `safeHTML` filter — so HTML passes through). When
 * `html` is supplied we send that, otherwise the plaintext body is wrapped
 * in a `<pre>` so the template still receives HTML.
 */
async function sendViaListmonk(params: EmailParams): Promise<void> {
  const body = params.html ?? `<pre>${escapeHtml(params.text)}</pre>`;
  const baseUrl = env.LISTMONK_URL.replace(/\/$/, "");
  const auth = Buffer.from(
    `${env.LISTMONK_API_USER}:${env.LISTMONK_API_TOKEN}`,
  ).toString("base64");
  const fromEmail = env.LISTMONK_FROM || env.LISTMONK_FROM_EMAIL;

  const response = await fetch(`${baseUrl}/api/tx`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subscriber_email: params.to,
      template_id: Number(env.LISTMONK_TX_TEMPLATE_ID),
      from_email: fromEmail,
      data: { subject: params.subject, body },
      content_type: "html",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Listmonk /api/tx error (${response.status}): ${text}`);
  }
}

/**
 * A user-supplied string made safe for an email header.
 *
 * Nodemailer already encodes headers, so this is not the only defence against
 * header injection — it is the one that does not depend on the transport:
 * Listmonk receives the subject as template data. Control characters (CR/LF
 * above all) go, whitespace runs collapse, and the result is capped so a
 * 200-character workspace name cannot push the actual subject off screen.
 */
export function headerSafe(value: string, max = 120): string {
  const flat = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export type WorkspaceInvitationEmail = {
  to: string;
  workspaceName: string;
  inviterName: string;
  url: string;
  /** The recipient's language, decided by the caller. English when unknown. */
  locale?: Locale | null;
  /** How long the link works, stated in the email. */
  expiresInHours: number;
};

/**
 * The invitation email, as data — separate from sending it so the escaping is
 * unit-tested without a transport.
 *
 * Both names are chosen by other users (anybody can name a workspace, and
 * anybody can call themselves anything), so they are flattened for the
 * subject and every HTML text node is escaped AFTER translation — escaping the
 * finished sentence covers the names wherever a translation puts them, which
 * escaping the values going in would not guarantee. The URL is built by the
 * server from an id it generated, and is escaped for the attribute anyway.
 */
export function buildWorkspaceInvitationEmail(
  params: WorkspaceInvitationEmail,
): EmailParams {
  const t = serverT(params.locale, "email");
  const values = {
    inviter: headerSafe(params.inviterName) || t("invitation.someone"),
    workspace: headerSafe(params.workspaceName) || t("invitation.aWorkspace"),
  };
  const intro = t("invitation.intro", values);
  const action = t("invitation.action");
  const expiry = t("invitation.expiry", { hours: String(params.expiresInHours) });
  return {
    to: params.to,
    subject: headerSafe(t("invitation.subject", values), 200),
    text: `${intro}\n\n${action}: ${params.url}\n\n${expiry}`,
    html:
      `<p>${escapeHtml(intro)}</p>` +
      `<p><a href="${escapeHtml(params.url)}">${escapeHtml(action)}</a></p>` +
      `<p>${escapeHtml(expiry)}</p>`,
  };
}

/** Send the invitation email. Throws on a delivery failure, like `sendEmail`. */
export async function sendWorkspaceInvitationEmail(
  params: WorkspaceInvitationEmail,
): Promise<void> {
  await sendEmail(buildWorkspaceInvitationEmail(params));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── runaway timer reminder ──────────────────────────────────────────────

export type RunawayReminderEmailInput = {
  to: string;
  /** The entry's description; empty is normal and reads as "Untitled". */
  description: string;
  start: Date;
  now: Date;
  /**
   * The person's runaway limit in seconds when the guard flagged the entry,
   * or null when the guard is off and the reminder comes from the fixed
   * threshold instead. Only the wording differs.
   */
  limitSec: number | null;
  /** Absolute link to the tracker, or null when no frontend URL is set. */
  trackUrl: string | null;
  /** The recipient's language (`preferredLocale`). English when unknown. */
  locale?: Locale | null;
};

/**
 * "9 h 12 min", "45 min". Hours and minutes only: this is an email. German
 * joins number and unit with a no-break space, as the glossary asks; English
 * keeps the plain space it always had.
 */
function formatReminderDuration(totalSec: number, locale: Locale | null | undefined): string {
  const space = locale === "de" ? "\u00a0" : " ";
  const minutes = Math.max(0, Math.floor(totalSec / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}${space}min`;
  return rest === 0 ? `${hours}${space}h` : `${hours}${space}h ${rest}${space}min`;
}

/** Stands in for the entry name while a sentence is escaped, then becomes `<strong>`. */
const NAME_SLOT = "\u0000name\u0000";

/**
 * The reminder sent once per entry by the runaway-reminder job
 * (services/scheduler/runaway-reminder.ts). Pure, so the copy is testable
 * without a transport.
 *
 * The start is written in UTC with the zone named. The server does not know
 * which of the person's devices they will read this on.
 */
export function buildRunawayReminderEmail(
  input: RunawayReminderEmailInput,
): EmailParams & { html: string } {
  const t = serverT(input.locale, "email");
  const elapsed = formatReminderDuration(
    (input.now.getTime() - input.start.getTime()) / 1000,
    input.locale,
  );
  const name = input.description.trim() || t("runawayReminder.untitled");
  const started = `${input.start.toISOString().slice(0, 16).replace("T", " ")} UTC`;

  const why =
    input.limitSec === null
      ? t("runawayReminder.forgot")
      : t("runawayReminder.pastLimit", {
          limit: formatReminderDuration(input.limitSec, input.locale),
        });
  const footer = t("runawayReminder.footer");
  const open = t("runawayReminder.open");

  const subject = headerSafe(t("runawayReminder.subject", { elapsed }), 200);
  const text = [
    t("runawayReminder.startedText", { name, started, elapsed }),
    why,
    ...(input.trackUrl ? [`${open}: ${input.trackUrl}`] : []),
    "",
    footer,
  ].join("\n");

  // Escaped after translation, like the invitation: the name is user input,
  // and escaping the finished sentence covers it wherever a language puts it.
  const startedHtml = escapeHtml(
    t("runawayReminder.startedHtml", { name: NAME_SLOT, started, elapsed }),
  ).replace(NAME_SLOT, `<strong>${escapeHtml(name)}</strong>`);
  const link = input.trackUrl
    ? `<p><a href="${escapeHtml(input.trackUrl)}">${escapeHtml(open)}</a></p>`
    : "";
  const html =
    `<p>${startedHtml}</p>` +
    `<p>${escapeHtml(why)}</p>${link}` +
    `<p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>`;

  return { to: input.to, subject, text, html };
}
