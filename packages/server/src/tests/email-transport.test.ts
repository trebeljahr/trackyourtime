import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type EmailTransportEnv,
  resolveFromAddress,
  resolveSmtpSecure,
  selectEmailTransport,
} from "../services/email.js";

// Transport selection is a pure function of the environment precisely so it
// can be asserted here — no socket, no database, no process env mutation.
const empty: EmailTransportEnv = {
  SMTP_HOST: "",
  EMAIL_FROM: "",
  LISTMONK_URL: "",
  LISTMONK_API_USER: "",
  LISTMONK_API_TOKEN: "",
  LISTMONK_TX_TEMPLATE_ID: "",
  LISTMONK_FROM_EMAIL: "",
  LISTMONK_FROM: "",
};

const fullListmonk: EmailTransportEnv = {
  ...empty,
  LISTMONK_URL: "https://listmonk.example.com",
  LISTMONK_API_USER: "api",
  LISTMONK_API_TOKEN: "token",
  LISTMONK_TX_TEMPLATE_ID: "1",
  LISTMONK_FROM_EMAIL: "noreply@example.com",
};

describe("selectEmailTransport", () => {
  it("logs to the console when nothing is configured", () => {
    assert.equal(selectEmailTransport(empty), "console");
  });

  it("selects SMTP as soon as a host is set", () => {
    assert.equal(
      selectEmailTransport({ ...empty, SMTP_HOST: "smtp.example.com" }),
      "smtp",
    );
  });

  it("selects SMTP even without a From address, so the failure is loud", () => {
    // The alternative — falling back to console logging — would look like
    // "email is not configured" to an operator who plainly configured it.
    const source = { ...empty, SMTP_HOST: "smtp.example.com", EMAIL_FROM: "" };
    assert.equal(selectEmailTransport(source), "smtp");
    assert.equal(resolveFromAddress(source), "");
  });

  it("prefers an explicitly configured SMTP host over a complete Listmonk", () => {
    assert.equal(
      selectEmailTransport({ ...fullListmonk, SMTP_HOST: "smtp.example.com" }),
      "smtp",
    );
  });

  it("ignores a whitespace-only SMTP host", () => {
    assert.equal(selectEmailTransport({ ...empty, SMTP_HOST: "   " }), "console");
    assert.equal(
      selectEmailTransport({ ...fullListmonk, SMTP_HOST: "  " }),
      "listmonk",
    );
  });

  it("selects Listmonk when its whole set is present", () => {
    assert.equal(selectEmailTransport(fullListmonk), "listmonk");
    assert.equal(
      selectEmailTransport({
        ...fullListmonk,
        LISTMONK_FROM_EMAIL: "",
        LISTMONK_FROM: "Track Your Time <noreply@example.com>",
      }),
      "listmonk",
    );
  });

  it("falls back to the console on a partial Listmonk config", () => {
    for (const missing of [
      "LISTMONK_URL",
      "LISTMONK_API_USER",
      "LISTMONK_API_TOKEN",
      "LISTMONK_TX_TEMPLATE_ID",
      "LISTMONK_FROM_EMAIL",
    ] as const) {
      assert.equal(
        selectEmailTransport({ ...fullListmonk, [missing]: "" }),
        "console",
        `expected a missing ${missing} to disqualify Listmonk`,
      );
    }
  });
});

describe("resolveFromAddress", () => {
  it("prefers EMAIL_FROM", () => {
    assert.equal(
      resolveFromAddress({
        ...fullListmonk,
        EMAIL_FROM: "hello@example.com",
        LISTMONK_FROM: "Listmonk <lm@example.com>",
      }),
      "hello@example.com",
    );
  });

  it("falls back to the Listmonk sender identity", () => {
    assert.equal(
      resolveFromAddress({
        ...fullListmonk,
        LISTMONK_FROM: "Track Your Time <noreply@example.com>",
      }),
      "Track Your Time <noreply@example.com>",
    );
    assert.equal(resolveFromAddress(fullListmonk), "noreply@example.com");
  });

  it("is empty when no sender is configured anywhere", () => {
    assert.equal(resolveFromAddress(empty), "");
  });
});

describe("resolveSmtpSecure", () => {
  it("follows the port when SMTP_SECURE is unset", () => {
    assert.equal(resolveSmtpSecure("", 465), true);
    assert.equal(resolveSmtpSecure("", 587), false);
    assert.equal(resolveSmtpSecure("", 25), false);
  });

  it("lets an explicit value override the port", () => {
    assert.equal(resolveSmtpSecure("true", 587), true);
    assert.equal(resolveSmtpSecure("FALSE", 465), false);
    assert.equal(resolveSmtpSecure(" true ", 25), true);
  });

  it("treats an unparseable value as unset rather than as true", () => {
    assert.equal(resolveSmtpSecure("yes", 587), false);
    assert.equal(resolveSmtpSecure("yes", 465), true);
  });
});

// A source-level guard, the same shape as workspace-scoping.test.ts, against
// the regression that shipped once already: auth.ts gated its three sends on
// `!env.LISTMONK_URL || !env.LISTMONK_TX_TEMPLATE_ID`, so a self-host with
// SMTP configured logged the reset URL and returned instead of sending. The
// bug is invisible at runtime — nothing throws, the mail simply never leaves
// — so the assertion is that no send site names a single provider's variables.
describe("auth.ts email guards", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "auth", "auth.ts"),
    "utf8",
  );

  it("branches on the transport-agnostic predicate", () => {
    // The guard shape, not every mention: `requireEmailVerification` reads
    // the same predicate to decide policy, and sends nothing.
    const guards = source.match(/if \(!isEmailDeliveryConfigured\(\)\)/g) ?? [];
    const sends = source.match(/await sendEmail\(/g) ?? [];
    // The floor first: comparing two counts alone passes on an auth.ts with
    // no sends left in it at all, which is the state where auth mail is most
    // broken. Two is what exists today — reset and verification. The
    // invitation email moved to services/membership/invitations.ts, which
    // takes the same predicate as a dependency (`emailConfigured`) and is
    // pinned in invitations.test.ts.
    assert.ok(
      sends.length >= 2,
      `auth.ts should send reset and verification mail; found ${sends.length} sendEmail calls`,
    );
    assert.equal(
      guards.length,
      sends.length,
      "every sendEmail in auth.ts needs an isEmailDeliveryConfigured guard",
    );
  });

  it("keeps the link in the log when a configured transport fails", () => {
    const logged = source.match(/logAuthUrl\("/g) ?? [];
    const sends = source.match(/await sendEmail\(/g) ?? [];
    // Two per send site: once when no transport is configured, once in the
    // catch around the send. The second one is the invisible half — mail
    // works until the relay does not, and a lost catch means the reset URL
    // an operator needs is nowhere at exactly the moment it is needed.
    assert.equal(
      logged.length,
      sends.length * 2,
      "every send needs the URL logged on both the unconfigured and the failed path",
    );
  });

  it("does not gate a send on one provider's variables", () => {
    assert.doesNotMatch(
      source,
      /LISTMONK_/,
      "a Listmonk-shaped guard silently disables a configured SMTP host",
    );
  });
});
