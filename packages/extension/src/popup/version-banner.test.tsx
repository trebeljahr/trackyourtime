import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  CLIENT_TOO_OLD,
  SELF_HOSTING_UPGRADING_URL,
  SERVER_TOO_OLD,
  type QueuedMutationSummary,
} from "@starter/core";
import { extensionT } from "../i18n";
import type { ServerCompatibility } from "../lib/messaging";
import { describeError } from "./errors";
import { VersionBanner } from "./version-banner";
import { HeldQueue } from "./workspace-bar";

const en = extensionT("en", "popup");
const de = extensionT("de", "popup");

const compatibility = (patch: Partial<ServerCompatibility>): ServerCompatibility => ({
  refusal: null,
  release: null,
  apiLevel: null,
  minServerApiLevel: 1,
  ...patch,
});

describe("VersionBanner", () => {
  test("renders nothing when the two fit, or nothing is known", () => {
    expect(renderToStaticMarkup(<VersionBanner compatibility={compatibility({})} t={en} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <VersionBanner compatibility={compatibility({ apiLevel: 3, release: "1.0.0" })} t={en} />,
      ),
    ).toBe("");
  });

  test("a server too old names its release and level, and links the upgrade guide", () => {
    const html = renderToStaticMarkup(
      <VersionBanner
        compatibility={compatibility({ refusal: SERVER_TOO_OLD, release: "0.0.9", apiLevel: 0 })}
        t={en}
      />,
    );
    expect(html).toContain('data-testid="version-banner"');
    expect(html).toContain("This server runs v0.0.9 (API level 0). This app needs level 1 or higher.");
    expect(html).toContain(`href="${SELF_HOSTING_UPGRADING_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  test("a server too old with no release says so", () => {
    const html = renderToStaticMarkup(
      <VersionBanner compatibility={compatibility({ refusal: SERVER_TOO_OLD, apiLevel: 0 })} t={de} />,
    );
    expect(html).toContain("älteren Version (API-Level 0)");
  });

  test("an app too old says to update the app, with no server link", () => {
    const html = renderToStaticMarkup(
      <VersionBanner compatibility={compatibility({ refusal: CLIENT_TOO_OLD, apiLevel: 2 })} t={en} />,
    );
    expect(html).toContain("This app is too old for this server. Update the app.");
    expect(html).not.toContain("href=");
  });
});

describe("the server switch refusal", () => {
  test("SERVER_TOO_OLD is translated with the reported level", () => {
    const details = { apiLevel: 0, release: "0.0.9", minApiLevel: 1 };
    expect(describeError("SERVER_TOO_OLD", "English", "https://old.example.com", en, details)).toBe(
      "old.example.com runs API level 0. This app needs level 1 or higher. Ask the server admin to update it.",
    );
    expect(describeError("SERVER_TOO_OLD", "English", "https://old.example.com", de, details)).toContain(
      "API-Level 0",
    );
  });
});

describe("HeldQueue", () => {
  test("rows waiting for a server update have their own group and words", () => {
    const row: QueuedMutationSummary = {
      queueId: "q-1",
      op: "entries.start",
      description: "Design review",
      workspaceId: "ws-a",
      workspaceName: "Acme",
      at: "2026-09-14T09:00:00.000Z",
      server: null,
      hold: "server-too-old",
    };
    const html = renderToStaticMarkup(
      <HeldQueue rows={[row]} onDiscard={async () => true} t={en} />,
    );
    expect(html).toContain('data-hold="server-too-old"');
    expect(html).toContain("Your server is older than this app; these changes will send once it&#x27;s updated");
    expect(renderToStaticMarkup(<HeldQueue rows={[row]} onDiscard={async () => true} t={de} />)).toContain(
      "Dein Server ist älter als diese App.",
    );
  });
});
