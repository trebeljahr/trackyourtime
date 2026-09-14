"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn, getSession, POST_AUTH_REDIRECT } from "@/lib/auth-client";
import { AuthHeader } from "@/components/auth-header";
import { NativeServerPicker } from "@/components/server-picker";
import {
  consumeSessionRevokedNotice,
  type SessionRevokedNotice,
} from "@/lib/session-revoked";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  /*
   * "Why am I looking at a login screen?"
   *
   * A device signed out from Settings → Devices lands here without having
   * touched anything, so the screen has to answer that question itself — a
   * toast fired during the redirect is gone in four seconds, and on a phone it
   * may have been in a pocket at the time.
   *
   * Read in an effect, never during render: every page is prerendered in Node
   * under `output: "export"`, and a notice that exists only in the browser
   * would make the first client render disagree with the served HTML.
   */
  const [revoked, setRevoked] = useState<SessionRevokedNotice | null>(null);
  useEffect(() => {
    setRevoked(consumeSessionRevokedNotice());
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result = await signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? "Login failed");
      } else {
        // See the note in signup: refresh the session before navigating.
        await getSession();
        router.replace(POST_AUTH_REDIRECT);
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="mx-auto w-full max-w-sm space-y-6">
        <AuthHeader
          title="Log in"
          subtitle="Enter your credentials to access your account"
        />

        {/* Renders nothing on web — the web app has no server to choose. */}
        <NativeServerPicker />

        {revoked && (
          <div
            className="rounded-md border border-border bg-muted/50 p-3 text-sm"
            data-testid="login-revoked"
            role="status"
          >
            <p className="font-medium">You were signed out</p>
            <p className="text-muted-foreground">
              {revoked.pending > 0
                ? `This device's access was revoked from another device. ${
                    revoked.pending
                  } unsent ${
                    revoked.pending === 1 ? "change is" : "changes are"
                  } still saved here and will be sent once you sign in again.`
                : "This device's access was revoked from another device. Sign in again to continue."}
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" data-testid="login-error">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="login-email"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="login-password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="login-submit"
          >
            {loading ? "Logging in..." : "Log in"}
          </button>
        </form>

        <div className="text-center text-sm">
          <Link href="/forgot-password" className="text-primary hover:underline">
            Forgot your password?
          </Link>
        </div>

        <div className="text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-primary hover:underline">
            Sign up
          </Link>
        </div>
      </div>
    </div>
  );
}
