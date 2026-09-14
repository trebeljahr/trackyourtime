"use client";

import * as React from "react";

import { TagManager } from "@/components/tags/tag-manager";
import { useT } from "@/i18n/use-t";

export default function TagsPage(): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  return (
    <div className="space-y-6" data-testid="tags-page">
      <header>
        <h1 className="text-2xl font-bold">{tc("fields.tags")}</h1>
        <p className="text-sm text-muted-foreground">{t("tags.description")}</p>
      </header>
      <TagManager />
    </div>
  );
}
