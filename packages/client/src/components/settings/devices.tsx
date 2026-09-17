"use client";

import * as React from "react";
import {
  Globe,
  Laptop,
  MonitorSmartphone,
  Puzzle,
  Smartphone,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { ClientKind, DeviceSession } from "@starter/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { translate } from "@/i18n/translate";
import { useFormat, type LocaleFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { userErrorMessage } from "@/lib/error-message";
import { useIsElectron } from "@/hooks/use-shell";

/**
 * Said in the desktop app when its session token is NOT written to disk:
 * Electron's `safeStorage` had no real encryption to offer (Linux with no
 * keyring), so the main process keeps the token in memory rather than store a
 * credential under obfuscation (`electron/src/secure-store.ts`). Without this
 * note, being signed out at every launch would look like a bug.
 *
 * Asked after mount only: the bridge does not exist while prerendering.
 */
export function DesktopTokenStorageNote(): React.JSX.Element | null {
  const desktop = useIsElectron();
  const t = useT("settings");
  const [backend, setBackend] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void window.electronAPI?.secureStore
      .status()
      .then((status) => {
        if (!cancelled) setBackend(status.persistent ? null : status.backend);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  if (!desktop || backend === null) return null;
  return (
    <div
      className="rounded-md border border-border bg-muted/50 p-3 text-sm"
      role="status"
      data-testid="desktop-token-not-persisted"
    >
      <p className="font-medium">{t("devices.tokenNotPersisted.title")}</p>
      <p className="text-muted-foreground">{t("devices.tokenNotPersisted.body", { backend })}</p>
    </div>
  );
}

const CLIENT_ICONS: Record<ClientKind, typeof Laptop> = {
  web: Globe,
  desktop: Laptop,
  mobile: Smartphone,
  raycast: Sparkles,
  extension: Puzzle,
  cli: Terminal,
  unknown: MonitorSmartphone,
};

/** "3 minutes ago" — sessions are short-lived enough that relative reads best. */
const formatRelative = (
  iso: string,
  f: LocaleFormat,
  words: { justNow: string; unknown: string },
): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return words.unknown;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return words.justNow;

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
    ["month", 2_592_000],
    ["year", 31_536_000],
  ];

  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let divisor = 60;
  for (const [candidate, size] of units) {
    if (seconds < size * 60 || candidate === "year") {
      unit = candidate;
      divisor = size;
      break;
    }
  }

  const formatter = new Intl.RelativeTimeFormat(f.intlLocale, { numeric: "auto" });
  return formatter.format(-Math.round(seconds / divisor), unit);
};

// ── sign-out dialog ──────────────────────────────────────────────────

type RevokeDeviceDialogProps = {
  device: DeviceSession | null;
  onOpenChange: (open: boolean) => void;
};

function RevokeDeviceDialog({
  device,
  onOpenChange,
}: RevokeDeviceDialogProps): React.JSX.Element {
  const utils = trpc.useUtils();
  const t = useT("settings");
  const tc = useT("common");

  const revokeMutation = trpc.devices.revoke.useMutation({
    onMutate: async ({ id }) => {
      await utils.devices.list.cancel();
      const previous = utils.devices.list.getData();
      utils.devices.list.setData(undefined, (old) =>
        old?.filter((item) => item.id !== id),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        utils.devices.list.setData(undefined, context.previous);
      }
      toast.error(
        userErrorMessage(error, translate("settings")("devices.toasts.revokeFailed")),
      );
    },
    onSuccess: () => {
      toast.success(translate("settings")("devices.toasts.revoked"));
    },
    onSettled: () => {
      void utils.devices.list.invalidate();
    },
  });

  return (
    <Dialog open={device !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="revoke-device-dialog">
        <DialogHeader>
          <DialogTitle>
            {device?.name
              ? t("devices.revoke.title", { name: device.name })
              : t("devices.revoke.titleThisDevice")}
          </DialogTitle>
          <DialogDescription>{t("devices.revoke.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="revoke-device-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={revokeMutation.isPending}
            onClick={() => {
              if (!device) return;
              revokeMutation.mutate({ id: device.id, originId: ORIGIN_ID });
              onOpenChange(false);
            }}
            data-testid="revoke-device-confirm"
          >
            {tc("actions.signOut")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── panel ────────────────────────────────────────────────────────────

/**
 * Every app signed in as you. There is no separate credential to hand out —
 * each client signs in the ordinary way and shows up here.
 */
export function DevicesPanel(): React.JSX.Element {
  const devicesQuery = trpc.devices.list.useQuery();
  const utils = trpc.useUtils();
  const t = useT("settings");
  const tc = useT("common");
  const f = useFormat();
  const relativeWords = {
    justNow: t("devices.justNow"),
    unknown: tc("status.unknown"),
  };
  const [revoking, setRevoking] = React.useState<DeviceSession | null>(null);

  const devices = devicesQuery.data ?? [];
  const others = devices.filter((device) => !device.current).length;

  const revokeOthers = trpc.devices.revokeOthers.useMutation({
    onError: (error) => {
      toast.error(
        userErrorMessage(error, translate("settings")("devices.toasts.revokeOthersFailed")),
      );
    },
    onSuccess: ({ revoked }) => {
      toast.success(
        translate("settings")("devices.toasts.revokedOthers", { count: revoked }),
      );
    },
    onSettled: () => {
      void utils.devices.list.invalidate();
    },
  });

  return (
    <Card data-testid="settings-devices">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("devices.title")}</CardTitle>
          <CardDescription>{t("devices.description")}</CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={others === 0 || revokeOthers.isPending}
          onClick={() => revokeOthers.mutate({ originId: ORIGIN_ID })}
          data-testid="revoke-other-devices"
        >
          {t("devices.revokeOthers")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <DesktopTokenStorageNote />
        {devicesQuery.isLoading ? (
          <div className="space-y-2" data-testid="devices-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : devices.length === 0 ? (
          <EmptyState
            icon={MonitorSmartphone}
            title={t("devices.empty.title")}
            description={t("devices.empty.description")}
            testId="devices-empty"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="devices-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("devices.columns.device")}</TableHead>
                  <TableHead>{t("devices.columns.signedIn")}</TableHead>
                  <TableHead>{t("devices.columns.lastActive")}</TableHead>
                  <TableHead className="text-right">
                    {t("devices.columns.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((device) => {
                  const Icon = CLIENT_ICONS[device.client] ?? CLIENT_ICONS.unknown;
                  return (
                    <TableRow
                      key={device.id}
                      data-testid={`device-row-${device.id}`}
                    >
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          <Icon className="size-4 shrink-0 text-muted-foreground" />
                          {device.name}
                          {device.clientVersion ? (
                            <span
                              className="whitespace-nowrap text-xs font-normal text-muted-foreground"
                              data-testid="device-client-version"
                            >
                              {t("devices.clientVersion", { version: device.clientVersion })}
                            </span>
                          ) : null}
                          {device.current ? (
                            <Badge
                              variant="secondary"
                              className="whitespace-nowrap"
                              data-testid="device-current-badge"
                            >
                              {t("devices.current")}
                            </Badge>
                          ) : null}
                        </span>
                        {device.ipAddress ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {device.ipAddress}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatRelative(device.createdAt, f, relativeWords)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatRelative(device.updatedAt, f, relativeWords)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={device.current}
                          onClick={() => setRevoking(device)}
                          data-testid={`revoke-device-${device.id}`}
                        >
                          {tc("actions.signOut")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <ConnectAnAppHint />
      </CardContent>

      <RevokeDeviceDialog
        device={revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      />
    </Card>
  );
}

/** Points at the pairing page, which is the non-obvious half of the flow. */
function ConnectAnAppHint(): React.JSX.Element {
  const t = useT("settings");
  return (
    <div
      className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      data-testid="connect-app-hint"
    >
      <p className="font-medium text-foreground">{t("devices.connectHint.title")}</p>
      <p className="mt-1">
        {t.rich("devices.connectHint.body", {
          link: (chunks) => (
            <a
              className="font-medium text-foreground underline underline-offset-4"
              href="/app/device"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </div>
  );
}
