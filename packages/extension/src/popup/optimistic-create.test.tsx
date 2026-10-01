// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RenamePanel } from "./catalog-edit";
import { Combobox } from "./combobox";
import { ProjectPicker } from "./project-picker";
import { TagPicker } from "./tag-picker";
import { TaskPicker } from "./task-picker";
import type { Task } from "@starter/core";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const deferred = () => {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
};
const click = async (selector: string) => {
  const element = host.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  await act(async () => {
    if (element!.getAttribute("role") === "option") {
      element!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else {
      element!.click();
    }
  });
};
const type = async (selector: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

test("create form immediately shows the row, then restores its draft on refusal", async () => {
  const request = deferred();
  const save = vi.fn(() => request.promise);
  const close = vi.fn();
  await act(async () => root.render(
    <RenamePanel title="New tag" row={{ id: "", name: "" }} create
      onSave={save} onClose={close} testId="tag" />,
  ));
  await type('[data-testid="tag-name"]', "Deep work");
  await click('[data-testid="tag-create"]');
  expect(host.querySelector('[data-testid="tag-optimistic"]')?.textContent).toBe("Deep work");
  expect(host.querySelector('[data-testid="tag-name"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  await act(async () => request.resolve(false));
  expect(host.querySelector<HTMLInputElement>('[data-testid="tag-name"]')?.value).toBe("Deep work");
  expect(host.querySelector('[data-testid="tag-optimistic"]')).toBeNull();
  await click('[data-testid="tag-create"]');
  expect(save).toHaveBeenCalledTimes(2);
});

test("inline creation closes the list immediately and restores the search on failure", async () => {
  const request = deferred();
  const pending = vi.fn();
  const change = vi.fn();
  await act(async () => root.render(
    <Combobox label="Client" options={[{ id: "old", label: "Existing" }]}
      value="old" onChange={change} onCreate={() => request.promise}
      onPendingChange={pending} testId="client" />,
  ));
  await type('[data-testid="client"]', "Acme");
  await click('[role="option"]');
  expect(host.querySelector<HTMLInputElement>('[data-testid="client"]')?.value).toBe("Acme");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(change).not.toHaveBeenCalled();
  await act(async () => request.resolve(false));
  expect(host.querySelector<HTMLInputElement>('[data-testid="client"]')?.value).toBe("Acme");
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(change).not.toHaveBeenCalled();
});

test("a confirmed task selects the server ID after showing its name immediately", async () => {
  const request = deferred();
  const change = vi.fn();
  const render = async (tasks: Task[]) => act(async () => root.render(
    <TaskPicker tasks={tasks} value={null} onChange={change}
      onCreate={() => request.promise} testId="task" />,
  ));
  await render([]);
  await type('[data-testid="task"]', "Design");
  await click('[role="option"]');
  expect(host.querySelector<HTMLInputElement>('[data-testid="task"]')?.value).toBe("Design");
  expect(change).not.toHaveBeenCalled();
  await act(async () => request.resolve(true));
  await render([{ id: "server-task", name: "Design", color: "#ffffff" } as Task]);
  expect(change).toHaveBeenCalledExactlyOnceWith("server-task");
});

test("project refusal restores color, billable setting and rate", async () => {
  const request = deferred();
  const create = vi.fn(() => request.promise);
  await act(async () => root.render(
    <ProjectPicker projects={[]} clients={[]} value={null} onChange={vi.fn()}
      onCreateClient={async () => true} onCreateProject={create} testId="project" />,
  ));
  await type('[data-testid="project"]', "Website");
  await click('[role="option"]');
  await type('[data-testid="project-new-rate"]', "85,5");
  await click('[data-testid="project-new-color-ef4444"]');
  await click('[data-testid="project-new-billable"]');
  await click('[data-testid="project-new-create"]');
  expect(host.querySelector('[data-testid="project-new-optimistic"]')?.textContent).toBe("Website");
  await act(async () => request.resolve(false));
  expect(host.querySelector<HTMLInputElement>('[data-testid="project-new-name"]')?.value).toBe("Website");
  expect(host.querySelector<HTMLInputElement>('[data-testid="project-new-rate"]')?.value).toBe("85,5");
  expect(host.querySelector('[data-testid="project-new-color-ef4444"]')?.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector('[data-testid="project-new-billable"]')?.getAttribute("aria-checked")).toBe("false");
});

for (const kind of ["task", "tag"] as const) {
  test(`${kind} picker propagates failure and keeps the inline name for retry`, async () => {
    const request = deferred();
    const change = vi.fn();
    await act(async () => root.render(kind === "task"
      ? <TaskPicker tasks={[]} value={null} onChange={change}
          onCreate={() => request.promise} testId="picker" />
      : <TagPicker tags={[]} value={[]} onChange={change}
          onCreate={() => request.promise} testId="picker" />,
    ));
    await type('[data-testid="picker"]', "Deep work");
    await click('[role="option"]');
    await act(async () => request.resolve(false));
    expect(host.querySelector<HTMLInputElement>('[data-testid="picker"]')?.value).toBe("Deep work");
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    expect(change).not.toHaveBeenCalled();
  });
}

test("a project cannot submit before its new client receives a server ID", async () => {
  const request = deferred();
  const create = vi.fn(async () => true);
  await act(async () => root.render(
    <ProjectPicker projects={[]} clients={[]} value={null} onChange={vi.fn()}
      onCreateClient={() => request.promise} onCreateProject={create} testId="project" />,
  ));
  await type('[data-testid="project"]', "Website");
  await click('[role="option"]');
  await type('[data-testid="project-new-client"]', "Acme");
  await click('[role="option"]');
  expect(host.querySelector<HTMLInputElement>('[data-testid="project-new-client"]')?.value).toBe("Acme");
  expect(host.querySelector<HTMLButtonElement>('[data-testid="project-new-create"]')?.disabled).toBe(true);
  await act(async () => {
    host.querySelector('[data-testid="project-new-name"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(create).not.toHaveBeenCalled();
  await act(async () => request.resolve(false));
  expect(host.querySelector<HTMLInputElement>('[data-testid="project-new-client"]')?.value).toBe("Acme");
  expect(host.querySelector<HTMLButtonElement>('[data-testid="project-new-create"]')?.disabled).toBe(false);
});
