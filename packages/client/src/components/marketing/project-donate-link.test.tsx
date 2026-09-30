// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectDonateLink } from "@/components/marketing/project-donate-link";
import { DONATE_URL } from "@/lib/site-links";

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	window.history.replaceState(null, "", "/");
});

describe("ProjectDonateLink", () => {
	it("serves a usable project link without reading the browser URL during render", () => {
		const html = renderToString(
			<ProjectDonateLink href={DONATE_URL}>Donate</ProjectDonateLink>,
		);
		expect(html).toContain(`href="${DONATE_URL}"`);
		expect(html).not.toContain("returnTo");
	});

	it("renders the local donation destination in development", () => {
		vi.stubEnv("NODE_ENV", "development");
		const html = renderToString(
			<ProjectDonateLink href={DONATE_URL}>Donate</ProjectDonateLink>,
		);
		expect(html).toContain(
			`href="http://localhost:3713${new URL(DONATE_URL).pathname}"`,
		);
	});

	it.each([
		"click",
		"auxClick",
		"pointerDown",
		"focus",
		"contextMenu",
	] as const)("keeps the exact current query and hash for %s", (interaction) => {
		window.history.replaceState(
			null,
			"",
			"/de/?source=a%20b&filter=x%2By#support",
		);
		render(<ProjectDonateLink href={DONATE_URL}>Donate</ProjectDonateLink>);
		const link = screen.getByRole("link");
		link.addEventListener("click", (event) => event.preventDefault());
		link.addEventListener("auxclick", (event) => event.preventDefault());
		if (interaction === "auxClick") {
			fireEvent(
				link,
				new MouseEvent("auxclick", {
					bubbles: true,
					cancelable: true,
					button: 1,
				}),
			);
		} else {
			fireEvent[interaction](link);
		}
		const destination = new URL(link.getAttribute("href")!);
		expect(destination.origin + destination.pathname).toBe(
			`http://localhost:3713${new URL(DONATE_URL).pathname}`,
		);
		expect(destination.searchParams.get("returnTo")).toBe(window.location.href);
	});

	it("refreshes the return destination after client navigation and keeps caller handlers", () => {
		const onFocus = vi.fn();
		render(
			<ProjectDonateLink href={DONATE_URL} onFocus={onFocus}>
				Donate
			</ProjectDonateLink>,
		);
		const link = screen.getByRole("link");
		fireEvent.focus(link);
		window.history.replaceState(null, "", "/support/?from=footer#faq");
		fireEvent.focus(link);
		expect(
			new URL(link.getAttribute("href")!).searchParams.getAll("returnTo"),
		).toEqual([window.location.href]);
		expect(onFocus).toHaveBeenCalledTimes(2);
	});
});
