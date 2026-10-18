/**
 * "Look again now": a rule was just saved for the app on screen, or a hold
 * was set, and the Autopilot driver should plan at once instead of on its
 * next tick. One listener in practice (`DesktopAutopilotDriver`); a plain set
 * rather than a DOM event, so nothing here depends on `window`.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function nudgeAutopilot(): void {
  for (const listener of [...listeners]) listener();
}

export function onAutopilotNudge(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
