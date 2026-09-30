// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchKeyboardVisibility } from "./keyboard-visibility";

let viewport: EventTarget & {
  height: number;
  offsetTop: number;
  scale: number;
};
let stop: () => void;
function input(top = 369, bottom = 409): HTMLInputElement {
  const field = document.createElement("input");
  field.type = "password";
  field.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
  field.getClientRects = () =>
    [field.getBoundingClientRect()] as unknown as DOMRectList;
  field.scrollIntoView = vi.fn();
  document.body.append(field);
  return field;
}
beforeEach(() => {
  vi.useFakeTimers();
  viewport = Object.assign(new EventTarget(), {
    height: 793,
    offsetTop: 0,
    scale: 1,
  });
  vi.stubGlobal("visualViewport", viewport);
  stop = watchKeyboardVisibility();
});
afterEach(() => {
  stop();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("reveals the focused password after iPad portrait-to-landscape keyboard resizing", () => {
  const field = input();
  field.focus();
  vi.runAllTimers();
  expect(field.scrollIntoView).not.toHaveBeenCalled();
  viewport.height = 316;
  window.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("resize"));
  vi.runAllTimers();
  expect(field.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
    block: "center",
    inline: "nearest",
    behavior: "instant",
  });
});
it("leaves visible fields alone and respects the visual viewport offset", () => {
  viewport.offsetTop = 100;
  viewport.height = 316;
  const field = input();
  field.focus();
  vi.runAllTimers();
  expect(field.scrollIntoView).not.toHaveBeenCalled();
  viewport.offsetTop = 400;
  viewport.dispatchEvent(new Event("resize"));
  vi.runAllTimers();
  expect(field.scrollIntoView).toHaveBeenCalledTimes(1);
});
it("uses the current focus after the resize settles, never a stale field", () => {
  const old = input();
  old.focus();
  viewport.height = 316;
  viewport.dispatchEvent(new Event("resize"));
  const current = input(40, 80);
  current.focus();
  vi.runAllTimers();
  expect(old.scrollIntoView).not.toHaveBeenCalled();
  expect(current.scrollIntoView).not.toHaveBeenCalled();
});
it("does not fight pinch zoom or user scroll", () => {
  const field = input();
  field.focus();
  viewport.height = 316;
  viewport.scale = 2;
  vi.runAllTimers();
  expect(field.scrollIntoView).not.toHaveBeenCalled();
  viewport.scale = 1;
  viewport.dispatchEvent(new Event("scroll"));
  vi.runAllTimers();
  expect(field.scrollIntoView).not.toHaveBeenCalled();
});
it("ignores readonly fields and cancels pending work during teardown", () => {
  const field = input();
  field.readOnly = true;
  field.focus();
  viewport.height = 316;
  vi.runAllTimers();
  expect(field.scrollIntoView).not.toHaveBeenCalled();
  field.readOnly = false;
  viewport.dispatchEvent(new Event("resize"));
  stop();
  vi.runAllTimers();
  expect(field.scrollIntoView).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("resize"));
  vi.runAllTimers();
  expect(field.scrollIntoView).not.toHaveBeenCalled();
});
