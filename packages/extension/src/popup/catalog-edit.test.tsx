import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CATALOG_COLORS } from "@starter/shared";
import { changedFields, parseRate, RenamePanel } from "./catalog-edit";

describe("changedFields", () => {
  const project = {
    name: "Redesign",
    clientId: "c1" as string | null,
    color: "#4f46e5",
    billableDefault: true,
    hourlyRate: null as number | null,
  };

  test("an untouched form sends nothing", () => {
    expect(changedFields(project, { ...project })).toEqual({});
  });

  test("sends only what moved, including a cleared client", () => {
    expect(
      changedFields(project, { ...project, name: "Rebrand", clientId: null }),
    ).toEqual({ name: "Rebrand", clientId: null });
  });

  test("never echoes a withheld rate back", () => {
    // A member without money visibility reads the rate as null; leaving the
    // field empty must not send `hourlyRate: null` over a real rate.
    expect(changedFields(project, { ...project, billableDefault: false })).toEqual({
      billableDefault: false,
    });
  });
});

describe("parseRate", () => {
  test("empty means the workspace default", () => {
    expect(parseRate("")).toBeNull();
    expect(parseRate("   ")).toBeNull();
  });

  test("accepts a decimal comma and rounds to cents", () => {
    expect(parseRate("85,5")).toBe(85.5);
    expect(parseRate("120.456")).toBe(120.46);
    expect(parseRate("0")).toBe(0);
  });

  test("refuses what is not a rate", () => {
    expect(parseRate("-1")).toBe("invalid");
    expect(parseRate("abc")).toBe("invalid");
  });
});

describe("RenamePanel", () => {
  const render = (row: { id: string; name: string; color?: string }): string =>
    renderToStaticMarkup(
      <RenamePanel
        title="Edit"
        row={row}
        onSave={() => Promise.resolve(true)}
        onClose={() => undefined}
        testId="panel"
      />,
    );

  test("offers the palette for a row that has a colour, with it selected", () => {
    const html = render({ id: "t1", name: "deep work", color: "#ef4444" });
    expect(html.match(/role="radio"/g)).toHaveLength(CATALOG_COLORS.length);
    expect(html).toContain('aria-checked="true" aria-label="Red"');
  });

  test("a task has a name and nothing else", () => {
    const html = render({ id: "t1", name: "Design review" });
    expect(html).not.toContain('role="radio"');
    expect(html).toContain('value="Design review"');
  });
});
