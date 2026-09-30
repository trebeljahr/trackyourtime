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

/** Self-contained branding: no remote images, tracking pixels or hosted-service links. */
function accountEmail(
  locale: Locale,
  kind: "verification" | "passwordReset",
  url: string,
  frontendUrl?: string,
): RenderedEmail {
  const t = serverT(locale, "email");
  const subject = t(`${kind}.subject`);
  const intro = t(`${kind}.intro`);
  const action = t(`${kind}.action`);
  const ignore = t(`${kind}.ignore`);
  const instance = frontendUrl ? new URL(frontendUrl).host : "Track Your Time";
  const esc = escapeHtml;
  return {
    subject,
    text: `Track Your Time · ${instance}\n\n${intro}\n${url}\n\n${ignore}`,
    html: `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#f5f5f7;color:#18181b;font-family:Arial,Helvetica,sans-serif;line-height:1.6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px;">
<tr><td style="padding:32px;border-top:4px solid #4f46e5;">
<p style="margin:0 0 8px;font-size:22px;font-weight:700;">Track Your <span style="color:#4f46e5;">Time</span></p>
<p style="margin:0 0 28px;color:#71717a;font-size:13px;">${esc(instance)}</p>
<h1 style="font-size:24px;line-height:1.25;margin:0 0 16px;">${esc(subject)}</h1>
<p>${esc(intro)}</p>
<p style="margin:28px 0;"><a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;">${esc(action)}</a></p>
<p style="font-size:12px;word-break:break-all;"><a href="${esc(url)}" style="color:#4f46e5;">${esc(url)}</a></p>
<p style="border-top:1px solid #e4e4e7;padding-top:20px;margin-top:28px;font-size:13px;color:#71717a;">${esc(ignore)}</p>
</td></tr></table></td></tr></table></body></html>`,
  };
}

export function passwordResetEmail(
  locale: Locale,
  url: string,
  frontendUrl?: string,
): RenderedEmail {
  return accountEmail(locale, "passwordReset", url, frontendUrl);
}

export function verificationEmail(
  locale: Locale,
  url: string,
  frontendUrl?: string,
): RenderedEmail {
  return accountEmail(locale, "verification", url, frontendUrl);
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
