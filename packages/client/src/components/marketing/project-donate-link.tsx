"use client";

import type {
	ComponentPropsWithoutRef,
	ReactElement,
	SyntheticEvent,
} from "react";

type Props = ComponentPropsWithoutRef<"a"> & { href: string };

/** Keep the current page, including filters and hash, through donation checkout. */
export function ProjectDonateLink({ href, ...props }: Props): ReactElement {
	const donationHref =
		process.env.NODE_ENV === "development"
			? href.replace(/^https:\/\/ricos\.site(?=\/|$)/, "http://localhost:3713")
			: href;

	function rememberPage(event: SyntheticEvent<HTMLAnchorElement>): void {
		const destination = new URL(donationHref);
		const current = new URL(window.location.href);
		// Local previews should stay local, even when serving a production build.
		if (["localhost", "127.0.0.1", "[::1]"].includes(current.hostname)) {
			destination.protocol = "http:";
			destination.host = "localhost:3713";
		}
		if (current.protocol === "https:" || current.protocol === "http:") {
			destination.searchParams.set("returnTo", current.href);
		}
		event.currentTarget.href = destination.href;
	}

	// Resolve on interaction so navigation since mount is preserved too. Keep
	// the server-rendered href stable for hydration and non-JavaScript visits.
	return (
		<a
			{...props}
			href={donationHref}
			onClick={(event) => {
				rememberPage(event);
				props.onClick?.(event);
			}}
			onAuxClick={(event) => {
				rememberPage(event);
				props.onAuxClick?.(event);
			}}
			onPointerDown={(event) => {
				rememberPage(event);
				props.onPointerDown?.(event);
			}}
			onFocus={(event) => {
				rememberPage(event);
				props.onFocus?.(event);
			}}
			onContextMenu={(event) => {
				rememberPage(event);
				props.onContextMenu?.(event);
			}}
		/>
	);
}
