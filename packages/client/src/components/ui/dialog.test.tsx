// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  dismissTopOverlay,
  overlayCount,
  resetOverlayStack,
} from "@/mobile/overlay-stack";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

/*
 * Every dialog in the app registers on the overlay stack the moment it opens,
 * so Android's hardware back button closes it instead of navigating away
 * underneath it. That happens once, here in the primitive, rather than in
 * each of the app's eleven dialogs — so a twelfth cannot forget.
 */

afterEach(() => {
  cleanup();
  resetOverlayStack();
});

const Fixture = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange?: (next: boolean) => void;
}): React.JSX.Element => (
  <Dialog open={open} {...(onOpenChange ? { onOpenChange } : {})}>
    <DialogContent>
      <DialogTitle>Edit entry</DialogTitle>
    </DialogContent>
  </Dialog>
);

describe("Dialog", () => {
  it("is on the overlay stack only while it is open", () => {
    const view = render(<Fixture open={false} onOpenChange={() => undefined} />);
    expect(overlayCount()).toBe(0);

    view.rerender(<Fixture open onOpenChange={() => undefined} />);
    expect(overlayCount()).toBe(1);

    view.rerender(<Fixture open={false} onOpenChange={() => undefined} />);
    expect(overlayCount()).toBe(0);
  });

  it("closes itself when the stack dismisses it", () => {
    const onOpenChange = vi.fn();
    render(<Fixture open onOpenChange={onOpenChange} />);

    expect(dismissTopOverlay()).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  /*
   * A dialog animates in and not out, and nothing else in the suite was
   * holding that.
   *
   * Radix keeps closed content mounted for the length of its exit animation
   * and its dismissable layer keeps listening the whole time, so an exit
   * animation leaves a full-viewport click-swallowing overlay over the page
   * for ~200ms after every close — which is what made the button that
   * reopens a dialog dead right after it was used (fix(ui): let a dialog
   * reopen the moment after it was closed).
   *
   * The E2E test written with that fix cannot catch its return: Playwright
   * waits for the trigger to be receiving pointer events before it clicks,
   * so it waits the lingering overlay out and the reopen it then performs
   * always succeeds — measured at ~520ms after the add, against a build with
   * the exit animation deliberately put back. A browser is the only place
   * the animation runs at all, and it is the place that cannot assert on it.
   *
   * So the invariant is pinned here on the classes instead. jsdom runs no
   * animations, which is exactly why this has to read the declaration rather
   * than observe the behaviour: unmount-on-close is what jsdom does anyway.
   */
  it("declares an entry animation and no exit animation", () => {
    render(<Fixture open onOpenChange={() => undefined} />);

    const content = document.querySelector("[data-slot='dialog-content']");
    const overlay = document.querySelector("[data-testid='dialog-overlay']");
    expect(content).not.toBeNull();
    expect(overlay).not.toBeNull();

    for (const node of [content, overlay]) {
      const classes = node?.getAttribute("class") ?? "";
      expect(classes).toContain("data-[state=open]:animate-in");
      expect(classes).not.toContain("data-[state=closed]:animate-out");
      expect(classes).not.toContain("data-[state=closed]:fade-out");
      expect(classes).not.toContain("data-[state=closed]:zoom-out");
    }
  });

  it("does not register when there is no way to close it", () => {
    // An uncontrolled dialog keeps its open state inside Radix. Registering
    // it would put an entry on the stack that back could pop but not close,
    // which is worse than not registering: the press is swallowed and
    // nothing happens.
    render(<Fixture open />);
    expect(overlayCount()).toBe(0);
  });
});
