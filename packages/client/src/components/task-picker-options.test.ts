import { describe, expect, it } from "vitest";

import { taskPickerOptions } from "./task-picker-options";

const tasks = [
  { id: "review", name: "Design review", projectIds: ["p1"] },
  { id: "invoicing", name: "Invoicing", projectIds: ["p2"] },
  { id: "fresh", name: "Fresh", projectIds: [] },
];

const suggested = (options: ReturnType<typeof taskPickerOptions>): string[] =>
  options.filter((option) => !option.searchOnly).map((option) => option.value);

describe("taskPickerOptions", () => {
  it("suggests every task when no project is picked", () => {
    expect(suggested(taskPickerOptions(tasks, null, null, "Other"))).toEqual([
      "review",
      "invoicing",
      "fresh",
    ]);
  });

  it("suggests only the picked project's tasks", () => {
    const options = taskPickerOptions(tasks, "p1", null, "Other");
    expect(suggested(options)).toEqual(["review"]);
  });

  it("keeps the other tasks findable by search, under their own heading", () => {
    const options = taskPickerOptions(tasks, "p1", null, "Other");
    const invoicing = options.find((option) => option.value === "invoicing");
    expect(invoicing).toMatchObject({ searchOnly: true, group: "Other" });
  });

  it("always suggests the selected task", () => {
    const options = taskPickerOptions(tasks, "p1", "invoicing", "Other");
    expect(suggested(options)).toEqual(["review", "invoicing"]);
  });

  it("lists everything when the server does not report associations", () => {
    const legacy = tasks.map(({ id, name }) => ({ id, name }));
    expect(suggested(taskPickerOptions(legacy, "p1", null, "Other"))).toEqual([
      "review",
      "invoicing",
      "fresh",
    ]);
  });
});
