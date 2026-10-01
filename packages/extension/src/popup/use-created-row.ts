import { useEffect, useRef, useState } from "react";

/**
 * Select the catalog row that a "Create X" just made, once it arrives.
 *
 * Creating a project, task or tag from inside a picker used to create it and
 * stop there: the row appeared in the dropdown and the field it was created
 * from stayed empty, so every new tag had to be picked a second time — and a
 * tag created mid-timer was silently not on the entry at all.
 *
 * Selecting it at the call site is not possible. The worker answers a create
 * with a whole snapshot rather than with the row, so there is no id to select;
 * and the snapshot is applied by a `setState` that has not necessarily been
 * rendered by the time the awaited promise resolves, so reading the fresh list
 * straight after the await is a race. Waiting for the row to APPEAR in props
 * is the version that cannot race — it runs on the render that actually has it.
 *
 * Matching on the name is what makes that work, and is safe: every one of
 * these names is unique per workspace server-side, or the create that just
 * succeeded would have been refused.
 */
export function useSelectWhenCreated<T extends { name: string }>(
  rows: readonly T[],
  onSelect: (row: T) => void,
): (name: string, create: () => Promise<boolean>) => Promise<boolean> {
  const [wanted, setWanted] = useState<string | null>(null);

  // Every caller rebuilds this callback each render; a ref keeps the effect
  // below from re-running for that alone — and keeps it reading the CURRENT
  // selection, which matters for the tag picker, where selecting means
  // appending to a list that has moved on since the create was started.
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (wanted === null) return;
    const row = rows.find(
      (candidate) => candidate.name.trim().toLowerCase() === wanted,
    );
    if (row === undefined) return;
    setWanted(null);
    select.current(row);
  }, [rows, wanted]);

  return async (name, create) => {
    const ok = await create();
    // A refusal leaves nothing to wait for. Anything still wanted from an
    // earlier attempt is dropped with it, so a name typed twice cannot select
    // a row the second attempt did not make.
    setWanted(ok ? name.trim().toLowerCase() : null);
    return ok;
  };
}
