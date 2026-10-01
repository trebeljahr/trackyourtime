import type { JSX } from "react";
import type { BackgroundState } from "../lib/messaging";
import { useT } from "../i18n/use-t";
import { Combobox } from "./combobox";
import { useSelectWhenCreated } from "./use-created-row";

export function ClientPicker({
  state,
  value,
  projectId,
  onChange,
  onCreate,
  disabled,
  onPendingChange,
  testId,
}: {
  state: BackgroundState;
  value?: string | null;
  projectId: string | null;
  onChange: (id: string | null) => void;
  onCreate: (name: string) => Promise<boolean>;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
  testId: string;
}): JSX.Element {
  const t = useT("popup");
  const create = useSelectWhenCreated(state.clients, (client) =>
    onChange(client.id),
  );
  const available = (state.compatibility?.apiLevel ?? 0) >= 7;
  const selected =
    value === undefined
      ? (state.projects.find((p) => p.id === projectId)?.clientId ?? null)
      : value;
  return (
    <Combobox
      label={t("fields.client")}
      options={state.clients.map((client) => ({
        id: client.id,
        label: client.name,
        color: client.color,
      }))}
      value={selected}
      onChange={onChange}
      emptyLabel={t("fields.noClient")}
      placeholder={t("fields.searchClients")}
      disabled={disabled || !available}
      disabledHint={!available ? t("fields.clientNeedsUpdate") : undefined}
      onCreate={async (name) => {
        return create(name, () => onCreate(name));
      }}
      onPendingChange={onPendingChange}
      createLabel={(name) => t("fields.createClient", { name })}
      testId={testId}
    />
  );
}
