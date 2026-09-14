import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    "choosing-a-self-hosted-time-tracker",
    "self-hosting",
    "e-invoices",
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
        // The generated page opens with an MDX comment, so Docusaurus would take
        // its sidebar label from the file name ("reference").
        { type: "doc", id: "api/reference", label: "API reference" },
        "api/webhooks",
      ],
    },
  ],
};

export default sidebars;
