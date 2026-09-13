import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    "choosing-a-self-hosted-time-tracker",
    "self-hosting",
    "mcp",
    {
      type: "category",
      label: "REST API",
      // Expanded by default: this is the section an outside integrator arrives
      // for, and a collapsed category hides the page that answers "how do I
      // authenticate" behind a click nobody knows to make.
      collapsed: false,
      link: { type: "doc", id: "api/overview" },
      items: [
        "api/authentication",
        "api/errors",
        "api/rate-limits",
        "api/reference",
        "api/webhooks",
      ],
    },
    // Left over from the starter this repo grew from: they describe the
    // monorepo, not the product. Kept last, and kept out of llms.txt
    // (scripts/llms/site.mjs, EXCLUDED_DOC_IDS), until they are rewritten.
    "getting-started",
    "architecture",
  ],
};

export default sidebars;
