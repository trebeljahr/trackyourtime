// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { SignInScreen, type SignInScreenProps } from "./sign-in-screen";

vi.mock("../lib/config", () => ({
  DEFAULT_API_URL: "https://api.trackyourtime.dev",
  BRIDGE_TARGET: "production",
}));

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
  test("without a web account, offers email and device code only", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} />);
    expect(html).not.toContain('data-testid="open-web-app"');
    expect(html).toContain("Using cloud");
    expect(html).not.toContain("Use your own server");
    expect(html).not.toContain("Signing in to");
    expect(html).toContain('data-testid="sign-in-web-app"');
    expect(html).toContain('data-testid="sign-in-form"');
    expect(html).toContain("Sign in with email");
    expect(html).toContain("Sign in with a device code");
    expect(html).not.toContain("Log In From Web App");
    expect(html).not.toContain("Get a code, then");
    expect(html).not.toContain("Already signed in on the web?");
  });

  test("shows the web account directly above its login button, after other choices", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} webAccount={{ userId: "reader", sessionCreatedAt: 123, email: "reader@example.test", image: "https://example.test/avatar.png" }} onConfirmWebAccount={vi.fn()} />);
    expect(html).toContain('data-testid="open-web-app"');
    expect(html).toContain('data-testid="web-account-identity"');
    expect(html).toContain("reader@example.test");
    expect(html).toContain('src="https://example.test/avatar.png"');
    expect(html.indexOf('data-testid="sign-in-web-app"')).toBeLessThan(html.indexOf('data-testid="web-account-identity"'));
    expect(html.indexOf('data-testid="web-account-identity"')).toBeLessThan(html.indexOf('data-testid="open-web-app"'));
  });

  test("no account offer stays hidden before server metadata arrives", () => {
    expect(renderToStaticMarkup(<SignInScreen {...props} webUrl={null} />))
      .not.toContain('data-testid="open-web-app"');
  });

  test("self-hosted servers offer manual sign-in", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} apiUrl="https://api.example.test" webUrl="https://example.test" />);
    expect(html).toContain('data-testid="sign-in-web-app"');
    expect(html).toContain('data-testid="sign-in-form"');
    expect(html).not.toContain('data-testid="open-web-app"');
  });

  test("a self-hosted web account can also use the background sign-in button", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props}
      apiUrl="https://api.example.test" webUrl="https://example.test"
      webAccount={{ userId: "reader", sessionCreatedAt: 123, email: "reader@example.test", image: null }}
      onConfirmWebAccount={vi.fn()} />);
    expect(html).toContain('data-testid="open-web-app"');
    expect(html).toContain("reader@example.test");
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
    const offer = container.querySelector<HTMLButtonElement>('[data-testid="open-web-app"]')!;
    const identity = container.querySelector('[data-testid="web-account-identity"]')!;
    expect(offer.textContent).toContain("Log In From Web App");
    expect(identity.textContent).toContain(account.email);
    expect(identity.querySelector("img")?.getAttribute("src")).toBe(account.image);
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
  expect(html).toContain('data-testid="open-web-app"');
  expect(html).toContain('data-testid="sign-in-form"');
  expect(html).toContain('data-testid="sign-in-web-app"');
});


test("header server control reveals and hides the self-hosted URL picker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SignInScreen {...props} serverVersion="Track Your Time 0.1.2 (8c2ad03)" />));
    const toggle = container.querySelector<HTMLButtonElement>(".header [data-testid='sign-in-change-server']")!;
    expect(toggle.textContent).toBe("Using cloud");
    expect(container.textContent).not.toContain("8c2ad03");
    expect(container.querySelector('[data-testid="server-picker"]')).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("enter the URL of your self-hosted server");
    expect(container.querySelector('[data-testid="api-url-input"]')).not.toBeNull();
    await act(async () => toggle.click());
    expect(container.querySelector('[data-testid="server-picker"]')).toBeNull();
    await act(async () => root.render(<SignInScreen {...props} apiUrl="https://my.example.test" />));
    expect(toggle.textContent).toBe("Using own server");
    expect(toggle.title).toBe("https://my.example.test");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});


test("confirmed web sign-in stays in the popup with no code or browser navigation", () => {
  const html = renderToStaticMarkup(<SignInScreen {...props} pendingDeviceAuth={{
    webAccount: true, userCode: "ABCDEFGH", expiresAt: Date.now() + 60000,
    verificationUrl: "https://trackyourtime.dev/app/device?user_code=ABCDEFGH",
  }} />);
  expect(html).toContain("Connecting your account in the background");
  expect(html).not.toContain('data-testid="device-continue"');
  expect(html).not.toContain('data-testid="device-user-code"');
  expect(html).toContain('data-testid="device-cancel"');
});
