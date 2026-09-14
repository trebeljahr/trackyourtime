/**
 * The words of every transactional email, in the recipient's language.
 *
 * Split from `services/email.ts`, which only knows how mail LEAVES the server:
 * these functions are pure — a locale and some arguments in, a subject and two
 * bodies out — so what a German user receives is unit-tested without a
 * transport, a socket or a database.
 *
 * Whose language: the RECIPIENT's stored preference, never the request's. A
 * password reset is requested by whoever typed the address, which says nothing
 * about the language the person reading the email reads. `preferredLocale`
 * (services/user-locale.ts) decides, and English is the answer whenever nobody
 * has chosen. The workspace invitation is built beside the transport in
 * `services/email.ts` (`buildWorkspaceInvitationEmail`), with the same rule.
 */
import type { Locale } from "@starter/shared";
import { serverT } from "../i18n/index.js";

/**
 * Everything interpolated into HTML goes through this — names are user input.
 * The same as `escapeHtml` in services/email.ts, repeated so this module stays
 * free of the transport (and of the config it loads).
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** What `sendEmail` needs, minus the address. */
export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

const paragraph = (text: string): string => `<p>${escapeHtml(text)}</p>`;
const link = (url: string, label: string): string =>
  `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`;

export function passwordResetEmail(locale: Locale, url: string): RenderedEmail {
  const t = serverT(locale, "email");
  return {
    subject: t("passwordReset.subject"),
    text: `${t("passwordReset.intro")}\n${url}\n\n${t("passwordReset.ignore")}`,
    html: [
      paragraph(t("passwordReset.intro")),
      link(url, t("passwordReset.action")),
      paragraph(t("passwordReset.ignore")),
    ].join(""),
  };
}

export function verificationEmail(locale: Locale, url: string): RenderedEmail {
  const t = serverT(locale, "email");
  return {
    subject: t("verification.subject"),
    text: `${t("verification.intro")}\n${url}\n\n${t("verification.ignore")}`,
    html: [
      paragraph(t("verification.intro")),
      link(url, t("verification.action")),
      paragraph(t("verification.ignore")),
    ].join(""),
  };
}

/**
 * The newsletter's double-opt-in email. Plain HTML on purpose — no
 * react-email, no templating engine; adjust styling here.
 *
 * `siteName` absent = the instance has not named its newsletter, and the
 * catalog's "this newsletter" stands in, in the recipient's language.
 */
export function newsletterConfirmationEmail(
  locale: Locale,
  args: { confirmUrl: string; siteName?: string; days: number },
): RenderedEmail {
  const t = serverT(locale, "email");
  const siteName = args.siteName ?? t("newsletterConfirmation.defaultSiteName");
  const esc = escapeHtml;
  const heading = t("newsletterConfirmation.heading");
  const lead = t("newsletterConfirmation.lead", { siteName });
  const body = t("newsletterConfirmation.body", { days: args.days });
  const action = t("newsletterConfirmation.action");
  const pasteUrl = t("newsletterConfirmation.pasteUrl");
  const ignore = t("newsletterConfirmation.ignore", { days: args.days });

  const html = `<!doctype html>
<html lang="${locale}">
  <head><meta charset="utf-8"></head>
  <body style="font-family:system-ui,sans-serif;line-height:1.55;color:#1a1a1a;max-width:560px;margin:0 auto;padding:32px 24px;">
    <h1 style="font-size:22px;margin:0 0 16px 0;font-weight:600;">${esc(heading)}</h1>
    <p style="margin:0 0 16px 0;">${esc(lead)}</p>
    <p style="margin:0 0 24px 0;">${esc(body)}</p>
    <p style="margin:24px 0;">
      <a href="${esc(args.confirmUrl)}" style="display:inline-block;padding:12px 22px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-weight:500;">
        ${esc(action)}
      </a>
    </p>
    <p style="margin:24px 0 8px 0;font-size:13px;color:#555;">${esc(pasteUrl)}</p>
    <p style="margin:0 0 24px 0;font-size:13px;color:#555;word-break:break-all;">${esc(args.confirmUrl)}</p>
    <hr style="border:0;border-top:1px solid #e5e5e5;margin:32px 0;">
    <p style="margin:0;font-size:12px;color:#777;">
      ${esc(ignore)}
    </p>
  </body>
</html>`;

  return {
    subject: t("newsletterConfirmation.subject", { siteName }),
    text: `${heading}\n\n${lead}\n${body}\n\n${args.confirmUrl}\n\n${ignore}`,
    html,
  };
}
