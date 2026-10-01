import { useRef } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useT } from "../i18n/use-t";
import { rememberTheme, useTheme } from "./theme";

export function ThemeToggle() {
  const theme = useTheme();
  const t = useT("popup");
  const menu = useRef<HTMLDetailsElement>(null);
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <details className="menu theme-toggle" ref={menu}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current) {
          menu.current.open = false;
          menu.current.querySelector("summary")?.focus();
        }
      }}>
      <summary className="icon-button" aria-label={t("general.theme")} title={t("general.theme")} data-testid="theme-toggle">
        <Icon size={16} aria-hidden="true" />
      </summary>
      <div className="menu__list" role="group" aria-label={t("general.theme")}>
        {(["system", "dark", "light"] as const).map((choice) => {
          const OptionIcon = choice === "system" ? Monitor : choice === "dark" ? Moon : Sun;
          return <button key={choice} type="button" className="menu__item"
            aria-pressed={theme === choice}
            data-testid={`theme-option-${choice}`}
            onClick={() => {
              rememberTheme(choice);
              if (menu.current) menu.current.open = false;
            }}>
            <OptionIcon size={16} aria-hidden="true" />
            {t(`general.themes.${choice}`)}
            {theme === choice && <Check size={14} aria-hidden="true" />}
          </button>;
        })}
      </div>
    </details>
  );
}
