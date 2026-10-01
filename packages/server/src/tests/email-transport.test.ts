import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type EmailTransportEnv,
  listmonkTxBody,
  resolveFromAddress,
  resolveSmtpSecure,
  selectEmailTransport,
} from "../services/email.js";

// Transport selection is a pure function of the environment precisely so it
// can be asserted here — no socket, no database, no process env mutation.
const empty: EmailTransportEnv = {
  EMAIL_TRANSPORT: "",
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
  EMAIL_TRANSPORT: "listmonk",
  LISTMONK_URL: "https://listmonk.example.com",
  LISTMONK_API_USER: "api",
  LISTMONK_API_TOKEN: "token",
  LISTMONK_TX_TEMPLATE_ID: "1",
  LISTMONK_FROM_EMAIL: "noreply@example.com",
};

const smtp = {
  ...empty,
  EMAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.example.test",
  EMAIL_FROM: "time@example.test",
};

describe("selectEmailTransport", () => {
  it("allows a fresh mail-free instance and explicit none", () => {
    assert.equal(selectEmailTransport(empty), "console");
    assert.equal(
      selectEmailTransport({
        ...fullListmonk,
        EMAIL_TRANSPORT: "none",
        SMTP_HOST: "smtp.example.test",
      }),
      "console",
    );
  });
  it("requires migration to an explicit choice when mail settings already exist", () => {
    for (const source of [
      { ...smtp, EMAIL_TRANSPORT: "" },
      { ...fullListmonk, EMAIL_TRANSPORT: "" },
    ]) {
      assert.throws(
        () => selectEmailTransport(source),
        /set EMAIL_TRANSPORT explicitly/,
      );
    }
  });
  it("uses only the selected provider when both are configured", () => {
    const both = {
      ...fullListmonk,
      SMTP_HOST: smtp.SMTP_HOST,
      EMAIL_FROM: smtp.EMAIL_FROM,
    };
    assert.equal(
      selectEmailTransport({ ...both, EMAIL_TRANSPORT: "smtp" }),
      "smtp",
    );
    assert.equal(
      selectEmailTransport({ ...both, EMAIL_TRANSPORT: "listmonk" }),
      "listmonk",
    );
  });
  it("does not fall back from incomplete SMTP to ready Listmonk", () => {
    assert.throws(
      () =>
        selectEmailTransport({
          ...fullListmonk,
          EMAIL_TRANSPORT: "smtp",
          SMTP_HOST: "smtp.example.test",
        }),
      /requires EMAIL_FROM/,
    );
  });
  it("does not fall back from incomplete Listmonk to ready SMTP", () => {
    for (const key of [
      "LISTMONK_URL",
      "LISTMONK_API_USER",
      "LISTMONK_API_TOKEN",
      "LISTMONK_TX_TEMPLATE_ID",
      "LISTMONK_FROM_EMAIL",
    ] as const) {
      assert.throws(
        () =>
          selectEmailTransport({
            ...fullListmonk,
            SMTP_HOST: smtp.SMTP_HOST,
            EMAIL_FROM: smtp.EMAIL_FROM,
            [key]: " ",
          }),
        /requires/,
      );
    }
  });
  it("ignores invalid inactive provider settings", () => {
    assert.equal(
      selectEmailTransport({ ...smtp, LISTMONK_URL: "bad" }),
      "smtp",
    );
    assert.equal(
      selectEmailTransport({ ...fullListmonk, SMTP_PORT: "bad" }),
      "listmonk",
    );
  });
  it("validates the selector without exposing its value", () => {
    assert.throws(
      () => selectEmailTransport({ ...empty, EMAIL_TRANSPORT: "secret-typo" }),
      (error) =>
        error instanceof Error &&
        error.message === "EMAIL_TRANSPORT must be smtp, listmonk or none",
    );
  });
  it("requires valid selected SMTP settings", () => {
    assert.throws(
      () => selectEmailTransport({ ...smtp, SMTP_HOST: " " }),
      /SMTP_HOST/,
    );
    assert.throws(
      () => selectEmailTransport({ ...smtp, SMTP_USER: "user" }),
      /both SMTP_USER and SMTP_PASSWORD/,
    );
    assert.throws(
      () => selectEmailTransport({ ...smtp, SMTP_PORT: "587junk" }),
      /SMTP_PORT/,
    );
    assert.throws(
      () => selectEmailTransport({ ...smtp, SMTP_SECURE: "yes" }),
      /SMTP_SECURE/,
    );
    assert.equal(selectEmailTransport(smtp), "smtp");
  });
  it("requires valid selected Listmonk settings", () => {
    assert.throws(
      () =>
        selectEmailTransport({
          ...fullListmonk,
          LISTMONK_URL: "file:///tmp/mail",
        }),
      /LISTMONK_URL/,
    );
    assert.throws(
      () =>
        selectEmailTransport({ ...fullListmonk, LISTMONK_TX_TEMPLATE_ID: "0" }),
      /positive integer/,
    );
    assert.equal(selectEmailTransport(fullListmonk), "listmonk");
    assert.equal(
      selectEmailTransport({
        ...fullListmonk,
        LISTMONK_FROM_EMAIL: "",
        LISTMONK_FROM: "Time <time@example.test>",
      }),
      "listmonk",
    );
  });
});

describe("resolveFromAddress", () => {
  it("does not borrow the other provider's sender", () => {
    assert.equal(
      resolveFromAddress({
        ...fullListmonk,
        EMAIL_TRANSPORT: "smtp",
        EMAIL_FROM: "",
      }),
      "",
    );
    assert.equal(
      resolveFromAddress({ ...fullListmonk, EMAIL_FROM: "smtp@example.test" }),
      "noreply@example.com",
    );
    assert.equal(resolveFromAddress(smtp), smtp.EMAIL_FROM);
    assert.equal(resolveFromAddress(empty), "");
  });
});

describe("listmonkTxBody", () => {
  const params = { to: "new@example.com", subject: "Verify", text: "a < b" };

  // Listmonk's default mode answers 400 for a recipient who is not a
  // subscriber, and nobody signing up, resetting a password or accepting an
  // invitation is one. The failure only shows once hosted mail is switched on.
  it("sends to people who are not newsletter subscribers", () => {
    const body = listmonkTxBody(params, fullListmonk);
    assert.equal(body.subscriber_mode, "external");
    assert.equal(body.subscriber_email, "new@example.com");
  });

  it("names the sender and template, and escapes a plain-text body", () => {
    const body = listmonkTxBody(params, {
      ...fullListmonk,
      LISTMONK_FROM: "Track Your Time <noreply@mail.trackyourtime.dev>",
    });
    assert.equal(
      body.from_email,
      "Track Your Time <noreply@mail.trackyourtime.dev>",
    );
    assert.equal(body.template_id, 1);
    assert.deepEqual(body.data, {
      subject: "Verify",
      body: "<pre>a &lt; b</pre>",
    });
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

  it("routes missing and failed delivery through the explicit link policy", () => {
    const logged = source.match(/logAuthUrl\("/g) ?? [];
    const sends = source.match(/await sendEmail\(/g) ?? [];
    // Two per send site: once when no transport is configured, once in the
    // catch around the send. The second one is the invisible half — mail
    // works until the relay does not, and a lost catch means the reset URL
    // an operator needs is nowhere at exactly the moment it is needed.
    assert.equal(
      logged.length,
      sends.length * 2,
      "every send must consult the guarded link policy on missing or failed delivery",
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
