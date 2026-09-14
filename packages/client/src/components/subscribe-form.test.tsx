import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubscribeForm } from "@/components/subscribe-form";

describe("SubscribeForm", () => {
  it("renders its copy from the marketing catalog", () => {
    const html = renderToStaticMarkup(<SubscribeForm />);
    expect(html).toContain("Email address");
    expect(html).toContain('placeholder="you@example.com"');
    expect(html).toContain(">Subscribe</button>");
    expect(html).toContain("Unsubscribe link in every issue.");
    expect(html).not.toContain("marketing.");
  });
});
