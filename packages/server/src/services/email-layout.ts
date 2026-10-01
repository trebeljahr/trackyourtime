import type { Locale } from "@starter/shared";

export const escapeEmailHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Tables and inline styles work in mail clients that strip modern CSS. */
export function emailAction(label: string, url: string, locale: Locale): string {
  const esc = escapeEmailHtml;
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 12px"><tr><td bgcolor="#4f46e5" style="border-radius:8px"><a href="${esc(url)}" style="display:inline-block;padding:13px 22px;color:#ffffff;background:#4f46e5;border-radius:8px;text-decoration:none;font-weight:700">${esc(label)}</a></td></tr></table>
<p style="margin:0 0 24px;color:#52525b;font-size:12px">${locale === "de" ? "Falls die Schaltfläche nicht funktioniert, kopiere diesen Link:" : "If the button does not work, copy this link:"}<br><a href="${esc(url)}" style="color:#4338ca;word-break:break-all">${esc(url)}</a></p>`;
}

export function emailLayout(locale: Locale, title: string, content: string, footer: string, instance?: string): string {
  const esc = escapeEmailHtml;
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#f5f5f7;color:#18181b;font-family:Arial,Helvetica,sans-serif;line-height:1.6">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px">
<tr><td style="padding:28px 32px;border-top:4px solid #4f46e5">
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:12px"><span style="display:inline-block;width:32px;height:32px;border:3px solid #4f46e5;border-radius:50%;text-align:center;line-height:29px;color:#4f46e5;font-size:20px;font-weight:700">◷</span></td><td style="font-size:21px;font-weight:700;line-height:1.2">Track Your <span style="color:#4f46e5">Time</span></td></tr></table>
${instance ? `<p style="margin:8px 0 0;color:#71717a;font-size:12px">${esc(instance)}</p>` : ""}
<h1 style="font-size:23px;line-height:1.3;margin:30px 0 18px">${esc(title)}</h1>
${content}
<p style="border-top:1px solid #e4e4e7;padding-top:20px;margin:30px 0 0;font-size:13px;color:#52525b">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;
}
