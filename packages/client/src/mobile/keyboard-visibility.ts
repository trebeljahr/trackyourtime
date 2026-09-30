/** Keep the active editor visible when iOS resizes its WebView around a keyboard. */
export function watchKeyboardVisibility(): () => void {
  const viewport = window.visualViewport;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const reveal = (): void => {
    pending = undefined;
    const field = document.activeElement;
    if (!(field instanceof HTMLElement)) return;
    const editable =
      (field instanceof HTMLInputElement &&
        !field.disabled &&
        !field.readOnly &&
        [
          "text",
          "email",
          "password",
          "search",
          "tel",
          "url",
          "number",
        ].includes(field.type)) ||
      (field instanceof HTMLTextAreaElement &&
        !field.disabled &&
        !field.readOnly) ||
      field.isContentEditable;
    if (!editable || field.getClientRects().length === 0) return;
    // Do not fight a deliberate pinch-zoom or ordinary user scrolling.
    if (viewport && viewport.scale !== 1) return;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const rect = field.getBoundingClientRect();
    if (rect.top < top || rect.bottom > bottom) {
      field.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
    }
  };
  const schedule = (): void => {
    clearTimeout(pending);
    // Keyboard and rotation animations can emit several intermediate sizes.
    pending = setTimeout(reveal, 150);
  };
  window.addEventListener("resize", schedule);
  viewport?.addEventListener("resize", schedule);
  document.addEventListener("focusin", schedule);
  return () => {
    clearTimeout(pending);
    window.removeEventListener("resize", schedule);
    viewport?.removeEventListener("resize", schedule);
    document.removeEventListener("focusin", schedule);
  };
}
