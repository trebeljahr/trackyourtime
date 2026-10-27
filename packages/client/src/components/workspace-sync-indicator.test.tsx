// @vitest-environment jsdom
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorkspaceSyncIndicator } from "./workspace-sync-indicator";
import { TooltipProvider } from "./ui/tooltip";
import { FixedLocale } from "@/i18n/locale-root";
afterEach(cleanup);
it("never shows a live connection as synced while private changes are still on this device", () => {
  render(<TooltipProvider><WorkspaceSyncIndicator status="open" privateSync={{ phase: "pending", pending: 1 }} /></TooltipProvider>);
  const indicator = screen.getByRole("link", { name: /1 private change still needs to sync/ }); expect(indicator.getAttribute("data-status")).toBe("connecting"); expect(indicator.getAttribute("href")).toBe("/app/settings#private-workspace-backup"); expect(screen.getByText("1 unsynced")).toBeTruthy();
});
it("keeps German conflict and local-copy recovery wording available on the existing indicator", () => {
  render(<FixedLocale locale="de"><TooltipProvider><WorkspaceSyncIndicator status="open" privateSync={{ phase: "conflict", pending: 2 }} /></TooltipProvider></FixedLocale>);
  expect(screen.getByRole("link", { name: /Deine gespeicherte Kopie bleibt erhalten/ }).getAttribute("data-status")).toBe("closed"); expect(screen.getByText("2 nicht synchronisiert")).toBeTruthy();
});
it("retains the existing standard socket label and uses private delivery status after verification", () => {
  const view = render(<TooltipProvider><WorkspaceSyncIndicator status="closed" privateSync={null} /></TooltipProvider>); expect(screen.getByLabelText("Offline — reconnecting").getAttribute("data-status")).toBe("closed");
  view.rerender(<TooltipProvider><WorkspaceSyncIndicator status="closed" privateSync={{ phase: "saved", pending: 0 }} /></TooltipProvider>); expect(screen.getByRole("link", { name: "Private workspace synced" }).getAttribute("data-status")).toBe("open");
});
