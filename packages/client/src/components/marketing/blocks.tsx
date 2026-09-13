import * as React from "react";
import Image from "next/image";
import Link from "next/link";

import { STORES, type StoreId } from "@/lib/site-links";
import { cn } from "@/lib/utils";

/** The top of every public page: who it is for, the claim, the proof. */
export function Hero({
  eyebrow,
  title,
  children,
  actions,
  shot,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  shot?: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-16 pb-12 sm:pt-24">
      <div className="max-w-3xl space-y-6">
        <p className="text-sm font-medium text-brand">{eyebrow}</p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl" data-testid="marketing-title">
          {title}
        </h1>
        <div className="space-y-4 text-lg text-muted-foreground">{children}</div>
        {actions && <div className="flex flex-wrap items-center gap-3 pt-2">{actions}</div>}
      </div>
      {shot && <div className="mt-14">{shot}</div>}
    </section>
  );
}

export function Section({
  title,
  children,
  className,
  id,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  id?: string;
}): React.ReactElement {
  return (
    <section id={id} className={cn("mx-auto max-w-6xl px-6 py-14", className)}>
      <h2 className="mb-6 max-w-3xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Body copy at reading width. */
export function Prose({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="max-w-2xl space-y-4 leading-relaxed text-muted-foreground [&_strong]:text-foreground">{children}</div>;
}

/** A section with the words on one side and a screenshot on the other. */
export function Feature({
  title,
  children,
  shot,
  reverse = false,
}: {
  title: string;
  children: React.ReactNode;
  shot?: React.ReactNode;
  reverse?: boolean;
}): React.ReactElement {
  return (
    <section className="mx-auto max-w-6xl px-6 py-14">
      <div className={cn("grid items-center gap-10", shot && "lg:grid-cols-2")}>
        <div className={cn("space-y-5", reverse && shot && "lg:order-2")}>
          <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h2>
          <div className="space-y-4 leading-relaxed text-muted-foreground [&_strong]:text-foreground">
            {children}
          </div>
        </div>
        {shot}
      </div>
    </section>
  );
}

/** A real capture of the product, framed so a white screenshot does not melt into a white page. */
export function Shot({
  src,
  alt,
  width,
  height,
  priority = false,
  className,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      priority={priority}
      className={cn("h-auto w-full rounded-xl border bg-muted shadow-sm", className)}
    />
  );
}

export function PrimaryLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  const className =
    "inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90";
  return href.startsWith("/") ? (
    <Link href={href} className={className}>{children}</Link>
  ) : (
    <a href={href} className={className}>{children}</a>
  );
}

export function SecondaryLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  const className =
    "inline-flex h-10 items-center rounded-md border px-5 text-sm font-medium hover:bg-accent";
  return href.startsWith("/") ? (
    <Link href={href} className={className}>{children}</Link>
  ) : (
    <a href={href} className={className}>{children}</a>
  );
}

/**
 * A store button, or — while the listing is not live — a plain statement that
 * it is not in that store yet. Never a link to a listing that does not exist.
 */
export function StoreLink({ store }: { store: StoreId }): React.ReactElement {
  const listing = STORES[store];
  if (listing.url) return <PrimaryLink href={listing.url}>{listing.label}</PrimaryLink>;
  return (
    <span
      className="inline-flex h-10 items-center rounded-md border border-dashed px-5 text-sm text-muted-foreground"
      data-testid={`store-pending-${store}`}
    >
      {listing.pending}
    </span>
  );
}

/** A two-column list of short facts: a term and what it means. */
export function FactList({
  items,
}: {
  items: ReadonlyArray<{ term: string; detail: React.ReactNode }>;
}): React.ReactElement {
  return (
    <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.term} className="space-y-1.5">
          <dt className="font-medium">{item.term}</dt>
          <dd className="leading-relaxed text-muted-foreground">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Questions and answers, one per row. Answers are short, so one column reads faster than a grid. */
export function Questions({
  items,
}: {
  items: ReadonlyArray<{ q: string; a: React.ReactNode }>;
}): React.ReactElement {
  return (
    <dl className="max-w-2xl divide-y">
      {items.map((item) => (
        <div key={item.q} className="space-y-2 py-5 first:pt-0">
          <dt className="font-medium">{item.q}</dt>
          <dd className="leading-relaxed text-muted-foreground">{item.a}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A plain bulleted list at reading width. */
export function Bullets({ items }: { items: ReadonlyArray<React.ReactNode> }): React.ReactElement {
  return (
    <ul className="max-w-2xl list-disc space-y-2 pl-5 leading-relaxed text-muted-foreground">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
