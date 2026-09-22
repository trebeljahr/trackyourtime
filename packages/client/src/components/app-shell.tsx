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
  Search,
  Settings as SettingsIcon,
  Tags as TagsIcon,
  Timer,
  User as UserIcon,
  UserCog,
  Users,
  X,
} from "lucide-react";
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
import { DesktopBridgePublisher } from "@/components/desktop/desktop-bridge-publisher";
import { ThemeSync } from "@/components/theme-sync";
import {
  CommandPalette,
  useCommandPaletteShortcut,
} from "@/components/command-palette/command-palette";
import { useT } from "@/i18n/use-t";
import { LocaleSync } from "@/i18n/locale-sync";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  useActiveWorkspace,
  WorkspaceSwitcher,
} from "@/components/workspace-switcher";
import { useNativeLifecycle } from "@/hooks/use-native-lifecycle";
import { VersionBanner } from "@/components/version-banner";
import { refreshServerLevel } from "@/lib/server-level";
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
import { useVisibleNavSections } from "@/components/members/nav-visibility";

// Re-exported because this module has always been where they lived; the rule
// itself now sits in lib/nav.ts so the tab bar can share it without a cycle.
export { isActiveRoute, type NavItem };

/**
 * Headings and labels are message keys, resolved with `t` at render time: this
 * list is evaluated once at import, before the locale is known.
 */
type NavSection = {
  heading: "manage" | null;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    heading: null,
    items: [
      { href: "/app/track", id: "track", icon: Timer },
      { href: "/app/timesheet", id: "timesheet", icon: Grid3x3 },
      { href: "/app/calendar", id: "calendar", icon: CalendarDays },
      { href: "/app/reports", id: "reports", icon: BarChart3 },
    ],
  },
  {
    heading: "manage",
    items: [
      { href: "/app/clients", id: "clients", icon: Users },
      { href: "/app/projects", id: "projects", icon: FolderKanban },
      { href: "/app/tasks", id: "tasks", icon: ListChecks },
      { href: "/app/tags", id: "tags", icon: TagsIcon },
      { href: "/app/invoices", id: "invoices", icon: Receipt, requires: "invoices" },
      { href: "/app/members", id: "members", icon: UserCog },
      { href: "/app/settings", id: "settings", icon: SettingsIcon },
    ],
  },
];

/** The label is `shell.sync.<status>`, resolved at render time. */
const STATUS_DOT: Record<SyncStatus, string> = {
  open: "bg-primary",
  connecting: "bg-muted-foreground animate-pulse",
  closed: "bg-destructive",
};

function SyncDot({ status }: { status: SyncStatus }): React.JSX.Element {
  const t = useT("shell");
  const label = t(`sync.${status}`);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex size-6 items-center justify-center"
          aria-label={label}
          data-testid="sync-status"
          data-status={status}
        >
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full", STATUS_DOT[status])}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function RunningTimerIndicator({
  pathname,
}: {
  pathname: string;
}): React.JSX.Element | null {
  const { entry, elapsedSec } = useRunningEntry();
  const { duration } = useFormatSettings();
  const { activeId, workspaces } = useActiveWorkspace();
  const t = useT("shell");
  const tc = useT("common");

  if (!entry) return null;

  // One running timer per person, across every workspace — so the timer in
  // the header can belong to a workspace other than the one on screen. Say
  // which, or the clock reads as time being tracked into this one.
  const elsewhere =
    activeId !== null && entry.workspaceId !== activeId
      ? (workspaces?.find((workspace) => workspace.id === entry.workspaceId)
          ?.name ?? null)
      : null;

  // On the tracker the bar right under the header IS the running timer, so
  // this pill would be the same clock twice, linking to the page it is on.
  // A timer from another workspace is not in that bar, so it keeps the pill.
  if (elsewhere === null && pathname.replace(/\/$/, "") === "/app/track") {
    return null;
  }

  return (
    <Link
      href="/app/track"
      className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-accent"
      data-testid="running-timer-indicator"
      data-workspace-id={entry.workspaceId}
      title={elsewhere === null ? undefined : t("workspace.runningIn", { name: elsewhere })}
    >
      {elsewhere === null ? null : (
        <span
          className="max-w-16 truncate text-xs text-muted-foreground sm:max-w-28"
          data-testid="running-timer-workspace"
        >
          {elsewhere}
        </span>
      )}
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
      />
      <span className="hidden max-w-40 truncate text-muted-foreground sm:inline">
        {entry.description.trim() === ""
          ? tc("empty.noDescription")
          : entry.description}
      </span>
      <span
        className="font-mono tabular-nums"
        data-testid="running-timer-elapsed"
      >
        {duration(elapsedSec)}
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
  const sections = useVisibleNavSections(NAV_SECTIONS);
  const t = useT("shell");
  return (
    <nav className="flex flex-col gap-4 px-3 py-4" data-testid="sidebar-nav">
      {sections.map((section, index) => (
        <div key={section.heading ?? `section-${index}`} className="grid gap-1">
          {section.heading ? (
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`nav.sections.${section.heading}`)}
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
                data-testid={`nav-${item.id}`}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{t(`nav.items.${item.id}`)}</span>
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
  const t = useT("shell");
  const tc = useT("common");

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
          aria-label={t("userMenu.label")}
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
            {user?.name ?? t("userMenu.signedIn")}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {user?.email ?? ""}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild data-testid="user-menu-profile">
          <Link href="/app/profile">
            <UserIcon className="size-4" />
            {t("userMenu.profile")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild data-testid="user-menu-settings">
          <Link href="/app/settings">
            <SettingsIcon className="size-4" />
            {t("userMenu.settings")}
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
          {tc("actions.signOut")}
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
 * renders only on `/app/track` — so reconnecting on any other screen drained
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
  const t = useT("shell");
  // Resume/pause for the native shells. A no-op on web, where nothing ever
  // calls the handlers it registers.
  useNativeLifecycle();
  // App start: learn what the server in use speaks (docs/versioning.md). A
  // resume asks again in `useNativeLifecycle`.
  React.useEffect(() => {
    void refreshServerLevel();
  }, []);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [lastPath, setLastPath] = React.useState(pathname);

  // A route change must never leave the mobile drawer covering the page.
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMobileOpen(false);
  }

  const closeMobile = React.useCallback((): void => setMobileOpen(false), []);
  const openMobile = React.useCallback((): void => setMobileOpen(true), []);

  // Mounted here so Cmd/Ctrl+K works on every protected screen.
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const togglePalette = React.useCallback(
    (): void => setPaletteOpen((current) => !current),
    [],
  );
  useCommandPaletteShortcut(togglePalette);
  const openPalette = React.useCallback((): void => setPaletteOpen(true), []);
  const paletteSections = useVisibleNavSections(NAV_SECTIONS);
  const openPaletteFromDrawer = React.useCallback((): void => {
    // The drawer goes first, so the two overlays never stack and back closes
    // the palette alone.
    setMobileOpen(false);
    setPaletteOpen(true);
  }, []);

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
            href="/app/track"
            className="flex h-14 items-center gap-2 px-4 font-semibold"
            data-testid="brand"
            data-window-inset
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
              aria-label={t("nav.close")}
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
                  aria-label={t("nav.close")}
                  data-testid="sidebar-close"
                >
                  <X className="size-4" />
                </Button>
              </div>
              <Separator />
              {/* The phone has no Cmd+K, so the palette gets an entry of its
                  own at the top of the drawer the More tab opens. */}
              <div className="px-3 pt-4">
                <button
                  type="button"
                  onClick={openPaletteFromDrawer}
                  className="flex w-full items-center gap-2.5 rounded-md border border-border px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  data-testid="sidebar-search"
                >
                  <Search className="size-4 shrink-0" />
                  <span className="truncate">{t("palette.open")}</span>
                </button>
              </div>
              <SidebarNav pathname={pathname} onNavigate={closeMobile} />
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <VersionBanner />
          <header
            className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur md:px-6"
            data-testid="app-header"
            data-window-drag
          >
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={openMobile}
              aria-label={t("nav.open")}
              data-testid="sidebar-toggle"
            >
              <Menu className="size-4" />
            </Button>

            <div className="ml-auto flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hidden md:inline-flex"
                    onClick={() => setPaletteOpen(true)}
                    aria-label={t("palette.openHint")}
                    aria-keyshortcuts="Meta+K Control+K"
                    data-testid="command-palette-open"
                  >
                    <Search className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("palette.openHint")} <kbd className="ml-1 font-mono">
                    {/* Only mounted while the tooltip is open, so reading the
                        platform cannot disagree with the prerendered HTML. */}
                    {typeof navigator !== "undefined" &&
                    /Mac|iPhone|iPad/.test(navigator.platform)
                      ? "⌘K"
                      : t("palette.ctrlK")}
                  </kbd>
                </TooltipContent>
              </Tooltip>
              <WorkspaceSwitcher />
              <RunningTimerIndicator pathname={pathname} />
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
          runtime `isCapacitor()` branch would be wrong under `output: "export"`.
        */}
        <MobileTabBar
          pathname={pathname}
          onOpenMore={openMobile}
          moreOpen={mobileOpen}
        />

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          sections={paletteSections}
        />

        {/* The desktop app's tray and global shortcuts. Inert on the web. */}
        <DesktopBridgePublisher onOpenPalette={openPalette} />
      </div>
    </TooltipProvider>
  );
}
