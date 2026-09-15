"use client";

import * as React from "react";

import { MembersScreen } from "@/components/members/members-screen";
import { useT } from "@/i18n/use-t";

export default function MembersPage(): React.JSX.Element {
  const t = useT("members");
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6" data-testid="members-page">
      <header>
        <h1 className="text-2xl font-bold">{t("page.title")}</h1>
      </header>
      <MembersScreen />
    </div>
  );
}
