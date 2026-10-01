// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BUILD_TARGETS } from "../../manifest.config";
import { SignInScreen, type SignInScreenProps } from "./sign-in-screen";

const config = vi.hoisted(() => ({
  DEFAULT_API_URL: "https://api.trackyourtime.dev",
  BRIDGE_TARGET: "production",
}));
vi.mock("../lib/config", () => config);
beforeEach(() => { config.BRIDGE_TARGET = "production"; });

const props: SignInScreenProps = {
  apiUrl: "https://api.trackyourtime.dev",
  serverVersion: null,
  webUrl: "https://trackyourtime.dev",
  pendingSync: 0,
  pendingDeviceAuth: null,
  deviceSignInError: null,
  error: null,
  onSignIn: vi.fn(),
  onStartDeviceSignIn: vi.fn(),
  onCancelDeviceSignIn: vi.fn(),
  onSetServer: vi.fn(),
};

describe("extension sign-in choices", () => {
  test("hosted Chrome offers email, device code, and a web connection retry", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} />);
    expect(html).toContain('data-testid="open-web-app"');
    expect(html).toContain("Use your own server");
    expect(html).toContain('data-testid="sign-in-web-app"');
    expect(html).toContain('data-testid="sign-in-form"');
    expect(html).toContain("Sign in with email");
    expect(html).toContain("Sign in with a device code");
    expect(html).toContain("Log In From Web App");
    expect(html).not.toContain("Get a code, then");
    expect(html).not.toContain("Already signed in on the web?");
  });

  test("shows the web account inside the login button", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} webAccount={{ userId: "reader", sessionCreatedAt: 123, email: "reader@example.test", image: "https://example.test/avatar.png" }} onConfirmWebAccount={vi.fn()} />);
    expect(html).toContain("Auto Log In From Web As");
    expect(html).toContain("reader@example.test");
    expect(html).toContain('src="https://example.test/avatar.png"');
  });

  test("hosted connection is available before server metadata arrives", () => {
    expect(renderToStaticMarkup(<SignInScreen {...props} webUrl={null} />))
      .toContain('data-testid="open-web-app"');
  });

  test("self-hosted servers offer manual sign-in", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} apiUrl="https://api.example.test" webUrl="https://example.test" />);
    expect(html).toContain('data-testid="sign-in-web-app"');
    expect(html).toContain('data-testid="sign-in-form"');
    expect(html).not.toContain('data-testid="open-web-app"');
  });

  test("Firefox offers the hosted web connection alongside explicit sign-in", () => {
    config.BRIDGE_TARGET = BUILD_TARGETS.firefox.bridgeTarget;
    const html = renderToStaticMarkup(<SignInScreen {...props} />);
    expect(html).toContain('data-testid="sign-in-web-app"');
    expect(html).toContain('data-testid="sign-in-form"');
    expect(html).toContain('data-testid="open-web-app"');
  });

  test("does not offer automatic connection for an unexpected web origin", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} webUrl="https://other.example.test" />);
    expect(html).not.toContain('data-testid="open-web-app"');
    expect(html).toContain('data-testid="sign-in-web-app"');
  });

  test("shows the code before a separate browser navigation action", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} pendingDeviceAuth={{
      userCode: "ABCD1234", expiresAt: Date.now() + 60000,
      verificationUrl: "https://trackyourtime.dev/app/device?user_code=ABCD1234",
    }} />);
    expect(html).toContain("ABCD1234");
    expect(html).toContain('data-testid="device-continue"');
    expect(html).toContain('data-testid="device-cancel"');
    expect(html).not.toContain('data-testid="sign-in-form"');
  });
});


test("shows the offered photo and email, and signs in only after confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirm = vi.fn(async () => true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const account = { userId: "u1", email: "rico@example.com", image: "https://example.com/avatar.png", sessionCreatedAt: 123 };
  try {
    await act(async () => root.render(<SignInScreen {...props} webAccount={account} onConfirmWebAccount={confirm} />));
    const offer = container.querySelector<HTMLButtonElement>('[data-testid="confirm-web-account"]')!;
    expect(offer.textContent).toContain("Auto Log In From Web As");
    expect(container.querySelector('[data-testid="open-web-app"]')).toBeNull();
    expect(offer.textContent).toContain(account.email);
    expect(offer.querySelector("img")?.getAttribute("src")).toBe(account.image);
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => offer.click());
    expect(confirm).toHaveBeenCalledExactlyOnceWith("u1", 123);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

test("accounts without a photo keep an initial and manual sign-in options", () => {
  const html = renderToStaticMarkup(<SignInScreen {...props}
    webAccount={{ userId: "u1", email: "rico@example.com", image: null, sessionCreatedAt: 123 }}
    onConfirmWebAccount={vi.fn()} />);
  expect(html).toContain('aria-hidden="true">R</span>');
  expect(html).toContain('data-testid="sign-in-form"');
  expect(html).toContain('data-testid="sign-in-web-app"');
});
