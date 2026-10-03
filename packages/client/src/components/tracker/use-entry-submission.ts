"use client";

import * as React from "react";
import { subscribeActiveWorkspace } from "@/lib/active-workspace";
import { entryMutationScope, sameEntryMutationScope, type EntryMutationResult } from "@/lib/entry-mutation-result";
import { userErrorMessage } from "@/lib/error-message";
import { useT } from "@/i18n/use-t";

export type EntrySubmission = {
  pending: boolean;
  error: string | null;
  submit: (write: () => Promise<EntryMutationResult>) => void;
  dismiss: () => void;
};

/** Shared draft lifecycle. A synchronous gate also catches double Enter/click. */
export const useEntrySubmission = (key: unknown, onDone: () => void): EntrySubmission => {
  const t = useT("tracker");
  React.useSyncExternalStore(subscribeActiveWorkspace,
    () => JSON.stringify(entryMutationScope()), () => "");
  const [session, setSession] = React.useState(() => ({ key, scope: entryMutationScope() }));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const gate = React.useRef<object | null>(null);
  const currentSession = React.useRef(session);
  if (session.key !== key) {
    const next = { key, scope: entryMutationScope() };
    setSession(next);
    setPending(false);
    setError(null);
  }
  React.useLayoutEffect(() => {
    currentSession.current = session;
    gate.current = null;
  }, [session]);
  React.useEffect(() => () => { gate.current = null; }, []);
  const changed = !sameEntryMutationScope(session.scope);

  const submit = (write: () => Promise<EntryMutationResult>): void => {
    if (gate.current !== null) return;
    if (!sameEntryMutationScope(session.scope)) {
      setError(t("mutations.scopeChanged"));
      return;
    }
    const token = {};
    gate.current = token;
    setPending(true);
    setError(null);
    void (async () => {
      let result: EntryMutationResult;
      try {
        result = await write();
      } catch (cause) {
        result = { ok: false, message: userErrorMessage(cause, t("mutations.saveFailed")) };
      }
      if (gate.current !== token || currentSession.current !== session) return;
      gate.current = null;
      setPending(false);
      if (!sameEntryMutationScope(session.scope)) {
        setError(t("mutations.scopeChanged"));
        return;
      }
      if (result.ok) onDone();
      else setError(result.message);
    })();
  };

  return {
    pending,
    error: changed ? t("mutations.scopeChanged") : error,
    submit,
    dismiss: () => { if (gate.current === null) onDone(); },
  };
};
