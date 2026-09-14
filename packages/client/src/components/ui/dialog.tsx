"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { useT } from "@/i18n/use-t";
import { useOverlay } from "@/mobile/overlay-stack";
import { cn } from "@/lib/utils";

/**
 * Radix's Root, plus one line of native shell: while it is open it is on the
 * overlay stack, so Android's hardware back button closes it instead of
 * navigating away underneath it.
 *
 * Registered here rather than in each of the app's eleven dialogs, so a
 * twelfth cannot forget. On web the whole thing is an array push and pop —
 * nothing reads the stack except a `backButton` listener, which only Android
 * ever fires.
 *
 * Only a CONTROLLED dialog registers: an uncontrolled one owns its open state
 * inside Radix and has no `onOpenChange` to close it with. Every dialog in
 * this app is controlled.
 */
function Dialog({
  open,
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>): React.JSX.Element {
  useOverlay(open === true && onOpenChange !== undefined, () =>
    onOpenChange?.(false),
  );
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />
  );
}
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    // A handle for asserting a dialog is gone. There is no exit animation
    // (see the className below), so the overlay unmounts together with the
    // content rather than lingering over it — and a test that waits on this
    // is checking exactly that, since a re-introduced exit animation would
    // leave a full-viewport click-swallowing layer behind and fail here.
    data-testid="dialog-overlay"
    className={cn(
      // Entry animation only. An exit animation keeps the dialog — and its
      // dismissable layer — mounted while it plays, and Radix reads that
      // lingering layer as still being on screen: the click that reopens the
      // dialog lands on it as an "interaction outside" and closes what it
      // just opened. See DialogContent below.
      "fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** The close button's screen-reader text, in the rendered language. */
function DialogCloseLabel(): React.JSX.Element {
  const tc = useT("common");
  return <span className="sr-only">{tc("a11y.close")}</span>;
}

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean;
  }
>(({ className, children, showCloseButton = true, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // styles/native.css anchors this to the top under the safe area on the
      // phone. Radix puts no stable class or attribute on it, and matching
      // `[role="dialog"]` would also catch the nav drawer and any popover
      // that borrows the role.
      data-slot="dialog-content"
      className={cn(
        // `max-h` + scroll, not a fixed height: a dialog is centred and
        // translated, so one taller than the viewport overflows off BOTH
        // edges and its footer becomes unreachable — the buttons are there,
        // visible to a test and to Radix, simply outside the screen. Forms
        // grow over time (the project dialog gained budget fields), so the
        // container caps itself rather than every form remembering to.
        // A dialog animates in but not out, and that is load-bearing rather
        // than a taste: Radix keeps closed content mounted for the length of
        // its exit animation, and its dismissable layer keeps listening the
        // whole time. The click that reopened the dialog reached that layer
        // as an interaction outside, which closed the dialog again in the
        // same click that opened it — so for ~200ms after a dialog was
        // dismissed, the button that reopens it was dead, and logging two
        // time entries in a row hung the second one. Suppressing that
        // dismissal is not enough either: reopening mid-exit leaves Radix's
        // layer bookkeeping out of step and the dialog comes back inert,
        // its own overlay swallowing every click. Unmounting on close is the
        // version with no window for either.
        "fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border border-border bg-background p-5 shadow-lg duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:rounded-lg",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
          <X className="size-4" />
          <DialogCloseLabel />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn("flex flex-col space-y-1.5 text-left", className)}
      {...props}
    />
  );
}
DialogHeader.displayName = "DialogHeader";

function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-base font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
