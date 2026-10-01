import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
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
  test("hosted Chrome offers automatic connection without password or device-code choices", () => {
    const html = renderToStaticMarkup(<SignInScreen {...props} />);
    expect(html).toContain('data-testid="open-web-app"');
    expect(html).toContain("Use your own server");
    expect(html).not.toContain('data-testid="sign-in-web-app"');
    expect(html).not.toContain('data-testid="sign-in-form"');
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

  test("Firefox retains manual sign-in on the hosted service", () => {
    config.BRIDGE_TARGET = "none";
    const html = renderToStaticMarkup(<SignInScreen {...props} />);
    expect(html).toContain('data-testid="sign-in-web-app"');
    expect(html).not.toContain('data-testid="open-web-app"');
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
