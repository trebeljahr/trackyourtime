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

import { emailAction, emailLayout, escapeEmailHtml as escapeHtml } from "./email-layout.js";

/** What `sendEmail` needs, minus the address. */
export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

function accountEmail(
  locale: Locale,
  kind: "verification" | "passwordReset" | "magicLink",
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
    html: emailLayout(locale, subject,
      `<p>${esc(intro)}</p>${emailAction(action, url, locale)}`,
      esc(ignore), frontendUrl ?? url),
  };
}

export function passwordResetEmail(
  locale: Locale,
  url: string,
  frontendUrl?: string,
): RenderedEmail {
  return accountEmail(locale, "passwordReset", url, frontendUrl);
}

export function magicLinkEmail(
  locale: Locale,
  url: string,
  frontendUrl?: string,
): RenderedEmail {
  return accountEmail(locale, "magicLink", url, frontendUrl);
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
  const ignore = t("newsletterConfirmation.ignore", { days: args.days });

  const html = emailLayout(locale, heading,
    `<p>${esc(lead)}</p><p>${esc(body)}</p>${emailAction(action, args.confirmUrl, locale)}`,
    esc(ignore), args.confirmUrl);

  return {
    subject: t("newsletterConfirmation.subject", { siteName }),
    text: `${heading}\n\n${lead}\n${body}\n\n${args.confirmUrl}\n\n${ignore}`,
    html,
  };
}
