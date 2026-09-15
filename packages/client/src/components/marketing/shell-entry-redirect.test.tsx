// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShellEntryRedirect } from "@/components/marketing/shell-entry-redirect";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const shell = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/app-shell-host", () => ({ isAppShell: () => shell.value }));

describe("ShellEntryRedirect", () => {
  afterEach(cleanup);

  beforeEach(() => {
    replace.mockClear();
    shell.value = false;
  });

  it("leaves a web visitor on the landing page", () => {
    render(<ShellEntryRedirect />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("moves a native or desktop shell on to the tracker", () => {
    shell.value = true;
    render(<ShellEntryRedirect />);
    expect(replace).toHaveBeenCalledWith("/app/track");
  });
});
