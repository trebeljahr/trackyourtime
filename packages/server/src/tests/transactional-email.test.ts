// Transactional email in the recipient's language, and the rule that decides
// which language that is.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml } from "../services/email.js";
import {
  newsletterConfirmationEmail,
  passwordResetEmail,
  verificationEmail,
} from "../services/transactional-email.js";
import { explicitLocale, preferredLocale } from "../services/user-locale.js";

const URL = "https://trackyourtime.dev/reset-password/abc?token=1&x=2";

describe("email language", () => {
  it("only an explicit preference counts; 'system' has no device to ask", () => {
    assert.equal(explicitLocale("de"), "de");
    assert.equal(explicitLocale("en"), "en");
    assert.equal(explicitLocale("system"), null);
    assert.equal(explicitLocale(null), null);
    assert.equal(explicitLocale(undefined), null);
  });

  it("nobody to ask is English, without a lookup", async () => {
    assert.equal(await preferredLocale([]), "en");
    assert.equal(await preferredLocale([null, undefined, ""]), "en");
  });
});

describe("password reset", () => {
  it("is English by default and carries the link in both bodies", () => {
    const email = passwordResetEmail("en", URL);
    assert.equal(email.subject, "Reset your password");
    assert.ok(email.text.includes(URL));
    assert.ok(email.html.includes(`href="${escapeHtml(URL)}"`));
    assert.ok(email.html.includes(">Reset your password</a>"));
  });

  it("is German for a German recipient", () => {
    const email = passwordResetEmail("de", URL);
    assert.equal(email.subject, "Passwort zurücksetzen");
    assert.ok(email.text.startsWith("Öffne diesen Link"));
    assert.ok(email.text.includes(URL));
    assert.ok(!email.html.includes("Reset"));
  });
});

describe("verification", () => {
  it("has a subject in each language", () => {
    assert.equal(verificationEmail("en", URL).subject, "Verify your email");
    assert.equal(verificationEmail("de", URL).subject, "E-Mail-Adresse bestätigen");
  });
});

describe("newsletter confirmation", () => {
  it("pluralises the expiry and falls back to a translated site name", () => {
    const en = newsletterConfirmationEmail("en", { confirmUrl: URL, days: 21 });
    assert.equal(en.subject, "Confirm your subscription · this newsletter");
    assert.ok(en.html.includes("The link is good for 21 days."));
    assert.ok(en.html.startsWith("<!doctype html>\n<html lang=\"en\">"));

    const one = newsletterConfirmationEmail("en", { confirmUrl: URL, days: 1, siteName: "Notes" });
    assert.ok(one.html.includes("The link is good for 1 day."));

    const de = newsletterConfirmationEmail("de", { confirmUrl: URL, days: 21 });
    assert.equal(de.subject, "Bestätige dein Abonnement · diesen Newsletter");
    assert.ok(de.html.includes("Der Link ist 21 Tage gültig."));
    assert.ok(de.html.includes("nach 21 Tagen ab."));
    assert.ok(de.html.includes('<html lang="de">'));
  });
});
