"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { DeleteAccountCard } from "@/components/settings/delete-account";
import { SettingRow } from "@/components/settings/setting-row";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";

/** Identity, email notifications, subscription status, sign-out and deletion. */
export function AccountSettings({
  onShowExport,
}: {
  /** Switch Settings to the export panel, offered before deleting. */
  onShowExport?: () => void;
} = {}): React.JSX.Element {
  const router = useRouter();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const profileQuery = trpc.profile.get.useQuery();
  const billingStatus = trpc.billing.status.useQuery();
  const [signingOut, setSigningOut] = React.useState(false);

  const updateProfile = trpc.profile.update.useMutation({
    onMutate: async (input) => {
      await utils.profile.get.cancel();
      const previous = utils.profile.get.getData();
      const notifications = input.preferences?.notifications;
      if (previous && notifications !== undefined) {
        utils.profile.get.setData(undefined, {
          ...previous,
          preferences: { ...previous.preferences, notifications },
        });
      }
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        utils.profile.get.setData(undefined, context.previous);
      }
      toast.error(error.message || "Could not update your profile");
    },
    onSettled: () => {
      void utils.profile.get.invalidate();
    },
  });

  const initials = (user?.name ?? user?.email ?? "?")
    .split(" ")
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const handleSignOut = (): void => {
    setSigningOut(true);
    void signOut()
      .then(() => {
        router.replace("/login");
      })
      .catch(() => {
        toast.error("Could not sign out. Try again.");
        setSigningOut(false);
      });
  };

  const status = billingStatus.data;

  return (
    <div className="space-y-6">
      <Card data-testid="settings-account">
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>
            The identity every client, project and time entry is scoped to.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border py-0">
          <SettingRow
            title="Signed in as"
            description={user?.email ?? "Loading…"}
            testId="setting-identity"
          >
            <div className="flex items-center gap-3 sm:justify-end">
              <Avatar className="size-9">
                {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span
                className="text-sm font-medium"
                data-testid="account-email"
              >
                {user?.name ?? user?.email ?? ""}
              </span>
            </div>
          </SettingRow>

          <SettingRow
            title="Email notifications"
            description="Product and account emails. Timer reminders are separate."
            testId="setting-notifications"
          >
            <Switch
              checked={profileQuery.data?.preferences.notifications ?? true}
              onCheckedChange={(notifications) =>
                updateProfile.mutate({ preferences: { notifications } })
              }
              aria-label="Email notifications"
              data-testid="notifications-toggle"
            />
          </SettingRow>

          <SettingRow
            title="Sign out"
            description="Ends this session on this device only."
            testId="setting-sign-out"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={signingOut}
              onClick={handleSignOut}
              data-testid="account-sign-out"
            >
              <LogOut className="size-4" />
              Sign out
            </Button>
          </SettingRow>
        </CardContent>
      </Card>

      {status?.enabled ? (
        <Card data-testid="settings-subscription">
          <CardHeader>
            <CardTitle>Subscription</CardTitle>
            <CardDescription>
              Manage your subscription and payment methods.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {status.configured ? (
              <Button
                type="button"
                variant="outline"
                data-testid="manage-billing"
              >
                Manage billing
              </Button>
            ) : (
              // Hatchkit scaffolds Stripe before the keys exist; this notice
              // names the missing vars and the exact dotenvx recipe so a
              // developer can wire it up without leaving the page.
              <div
                className="space-y-3 rounded-md border border-amber-500/40 bg-amber-50/40 p-4 dark:bg-amber-950/20"
                data-testid="stripe-unconfigured-notice"
              >
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  Stripe is not fully configured
                  {status.mode ? ` (mode: ${status.mode})` : ""}.
                </p>
                <p className="text-sm text-muted-foreground">
                  Billing endpoints (checkout, billing portal, webhooks) will
                  return errors until every Stripe secret has a real value. The
                  rest of the app is unaffected.
                </p>
                <div className="space-y-1 text-sm">
                  <p className="font-medium">Missing env vars:</p>
                  <ul className="ml-4 list-disc text-muted-foreground">
                    {status.missingKeys.map((key) => (
                      <li key={key}>
                        <code className="rounded bg-muted px-1 py-0.5 text-xs">
                          {key}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
                <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                  {status.missingKeys
                    .map(
                      (key) =>
                        `pnpm --filter @starter/server exec dotenvx set ${key} <value> -f ${status.envFile}${status.requiresEncryption ? " --encrypt" : ""}`
                    )
                    .join("\n")}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  disabled
                  data-testid="manage-billing-disabled"
                >
                  Manage billing (unavailable)
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <DeleteAccountCard onShowExport={onShowExport} />
    </div>
  );
}
