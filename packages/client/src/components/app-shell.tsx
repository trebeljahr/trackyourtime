"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  CalendarDays,
  ChevronRight,
  FolderKanban,
  Grid3x3,
  ListChecks,
  LogOut,
  Menu,
  Receipt,
  Settings as SettingsIcon,
  Tags as TagsIcon,
  Timer,
  User as UserIcon,
  Users,
  X,
} from "lucide-react";
import { formatDuration } from "@starter/shared";
import type { SyncStatus } from "@starter/core";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeSync } from "@/components/theme-sync";
import { LocaleSync } from "@/i18n/locale-sync";
import { ThemeToggle } from "@/components/theme-toggle";
import { useNativeLifecycle } from "@/hooks/use-native-lifecycle";
import { useRunningEntry, useSync } from "@/hooks/use-sync";
import { OfflineQueueProvider } from "@/providers/offline-queue-provider";
import { useFormatSettings } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/auth-client";
import { isActiveRoute, type NavItem } from "@/lib/nav";
import { MobileTabBar } from "@/components/mobile-tab-bar";
import { useOverlay } from "@/mobile/overlay-stack";
import { handleBackPress } from "@/mobile/back-button";
import { setMobileHandlers } from "@/mobile/bridge";
import { cn } from "@/lib/utils";

// Re-exported because this module has always been where they lived; the rule
// itself now sits in lib/nav.ts so the tab bar can share it without a cycle.
export { isActiveRoute, type NavItem };

type NavSection = {
  heading: string | null;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    heading: null,
    items: [
      { href: "/track", label: "Track", icon: Timer },
      { href: "/timesheet", label: "Timesheet", icon: Grid3x3 },
      { href: "/calendar", label: "Calendar", icon: CalendarDays },
      { href: "/reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    heading: "Manage",
    items: [
      { href: "/clients", label: "Clients", icon: Users },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/tasks", label: "Tasks", icon: ListChecks },
      { href: "/tags", label: "Tags", icon: TagsIcon },
      { href: "/invoices", label: "Invoices", icon: Receipt },
      { href: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

const STATUS_COPY: Record<SyncStatus, { label: string; dot: string }> = {
  open: { label: "Live — changes sync across your devices", dot: "bg-primary" },
  connecting: { label: "Connecting…", dot: "bg-muted-foreground animate-pulse" },
  closed: { label: "Offline — reconnecting", dot: "bg-destructive" },
};

function SyncDot({ status }: { status: SyncStatus }): React.JSX.Element {
  const copy = STATUS_COPY[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex size-6 items-center justify-center"
          aria-label={copy.label}
          data-testid="sync-status"
          data-status={status}
        >
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full", copy.dot)}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{copy.label}</TooltipContent>
    </Tooltip>
  );
}

function RunningTimerIndicator(): React.JSX.Element | null {
  const { entry, elapsedSec } = useRunningEntry();
  const { durationFormat } = useFormatSettings();

  if (!entry) return null;

  return (
    <Link
      href="/track"
      className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-accent"
      data-testid="running-timer-indicator"
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
      />
      <span className="hidden max-w-40 truncate text-muted-foreground sm:inline">
        {entry.description.trim() === ""
          ? "No description"
          : entry.description}
      </span>
      <span
        className="font-mono tabular-nums"
        data-testid="running-timer-elapsed"
      >
        {formatDuration(elapsedSec, durationFormat)}
      </span>
    </Link>
  );
}

function SidebarNav({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}): React.JSX.Element {
  return (
    <nav className="flex flex-col gap-4 px-3 py-4" data-testid="sidebar-nav">
      {NAV_SECTIONS.map((section, index) => (
        <div key={section.heading ?? `section-${index}`} className="grid gap-1">
          {section.heading ? (
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {section.heading}
            </p>
          ) : null}
          {section.items.map((item) => {
            const active = isActiveRoute(pathname, item);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors",
                  active
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
                {active ? (
                  <ChevronRight className="ml-auto size-3.5 opacity-60" />
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function UserMenu(): React.JSX.Element {
  const router = useRouter();
  const { user } = useAuth();

  const initials = (user?.name ?? user?.email ?? "?")
    .trim()
    .slice(0, 2)
    .toUpperCase();

  const handleSignOut = React.useCallback(async (): Promise<void> => {
    await signOut();
    router.push("/login");
  }, [router]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label="Account menu"
          data-testid="user-menu"
        >
          <Avatar className="size-7">
            {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm font-medium">
            {user?.name ?? "Signed in"}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {user?.email ?? ""}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild data-testid="user-menu-profile">
          <Link href="/profile">
            <UserIcon className="size-4" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild data-testid="user-menu-settings">
          <Link href="/settings">
            <SettingsIcon className="size-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            void handleSignOut();
          }}
          data-testid="sign-out"
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type AppShellProps = {
  children: React.ReactNode;
};

/**
 * Sidebar + top bar chrome for every signed-in screen. Also the single mount
 * point for the realtime sync socket and the offline queue — mounting either
 * anywhere else would open a second connection, or a second flush loop, per
 * tab.
 *
 * The queue is a provider around the shell rather than a hook inside it
 * because the resume handler needs the same `flush` the tracker bar shows the
 * pending count for. Until now the queue was mounted in `TrackerBar`, which
 * renders only on `/track` — so reconnecting on any other screen drained
 * nothing at all.
 */
export function AppShell({ children }: AppShellProps): React.JSX.Element {
  return (
    <OfflineQueueProvider>
      <AppShellChrome>{children}</AppShellChrome>
    </OfflineQueueProvider>
  );
}

function AppShellChrome({ children }: AppShellProps): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const status = useSync();
  // Resume/pause for the native shells. A no-op on web, where nothing ever
  // calls the handlers it registers.
  useNativeLifecycle();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [lastPath, setLastPath] = React.useState(pathname);

  // A route change must never leave the mobile drawer covering the page.
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMobileOpen(false);
  }

  const closeMobile = React.useCallback((): void => setMobileOpen(false), []);
  const openMobile = React.useCallback((): void => setMobileOpen(true), []);

  // The drawer is an overlay like any dialog, so Android's back button closes
  // it before it does anything else. Registering here rather than on the
  // rendered <aside> keeps the stack entry alive for exactly as long as the
  // state that owns it.
  useOverlay(mobileOpen, closeMobile);

  /*
   * Android's hardware back button. The decision itself lives in
   * mobile/back-button.ts so it can be tested without mounting the shell;
   * what belongs here is the wiring.
   *
   * Registered through `setMobileHandlers` rather than passed into
   * `initMobile`: that function latches on its first call, which is
   * MobileBridgeLoader at the app root, long before this shell exists — so
   * a handler handed to `initMobile` here would be dropped in silence.
   */
  const handleBackButton = React.useCallback(
    (): boolean =>
      handleBackPress({ pathname, navigate: (href) => router.push(href) }),
    [pathname, router],
  );

  React.useEffect(
    () => setMobileHandlers({ onBackButton: handleBackButton }),
    [handleBackButton],
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-screen bg-background">
        {/* Desktop sidebar */}
        <aside
          className="hidden w-56 shrink-0 border-r border-border md:flex md:flex-col"
          data-testid="sidebar"
        >
          <Link
            href="/track"
            className="flex h-14 items-center gap-2 px-4 font-semibold"
            data-testid="brand"
          >
            <BrandMark />
            <span>Track Your Time</span>
          </Link>
          <Separator />
          <SidebarNav pathname={pathname} />
        </aside>

        {/* Mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-black/50"
              onClick={closeMobile}
              data-testid="sidebar-backdrop"
            />
            <aside
              className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-background shadow-lg"
              data-testid="sidebar-mobile"
            >
              <div className="flex h-14 items-center justify-between px-4">
                <span className="flex items-center gap-2 font-semibold">
                  <BrandMark />
                  Track Your Time
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={closeMobile}
                  aria-label="Close navigation"
                  data-testid="sidebar-close"
                >
                  <X className="size-4" />
                </Button>
              </div>
              <Separator />
              <SidebarNav pathname={pathname} onNavigate={closeMobile} />
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur md:px-6"
            data-testid="app-header"
          >
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={openMobile}
              aria-label="Open navigation"
              data-testid="sidebar-toggle"
            >
              <Menu className="size-4" />
            </Button>

            <div className="ml-auto flex items-center gap-1.5">
              <RunningTimerIndicator />
              <SyncDot status={status} />
              <ThemeSync />
              <LocaleSync />
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>

          <main
            className="min-w-0 flex-1 px-3 py-4 md:px-6 md:py-6"
            data-testid="app-main"
          >
            {children}
          </main>
        </div>

        {/*
          Rendered on every platform and hidden with `display: none` unless
          `html.cap` is set — see components/mobile-tab-bar.tsx for why a
          runtime `isNative()` branch would be wrong under `output: "export"`.
        */}
        <MobileTabBar
          pathname={pathname}
          onOpenMore={openMobile}
          moreOpen={mobileOpen}
        />
      </div>
    </TooltipProvider>
  );
}
