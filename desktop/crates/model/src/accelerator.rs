//! The accelerator grammar both ends agree on, ported from
//! `packages/shared/src/desktop-shortcuts.ts`.
//!
//! Settings → Desktop records accelerators from a key press in the renderer,
//! which parses with the TypeScript copy; the shell parses with this one. Both
//! produce the same canonical spelling (`CommandOrControl+Alt+Shift+Space`), so
//! a string the recorder produces is exactly a string the shell accepts, and a
//! hand-edited settings file with something the OS layer would throw on is
//! refused rather than registered.
//!
//! The canonical spelling stays Electron's, because it is what
//! `desktop-settings.json` holds on every existing install. The global-shortcut
//! plugin parses another grammar (the `global-hotkey` crate's), so
//! [`tauri_accelerator`] translates at the registration boundary.

use tyt_wire::{DesktopShortcutAction, DesktopShortcutBindings};

use crate::timer_menu::js::{js_trim, utf16_len};

/// Canonical modifier names, in the order a canonical accelerator lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AcceleratorModifier {
    CommandOrControl,
    Command,
    Control,
    Super,
    Alt,
    Shift,
}

pub const MODIFIER_ORDER: [AcceleratorModifier; 6] = [
    AcceleratorModifier::CommandOrControl,
    AcceleratorModifier::Command,
    AcceleratorModifier::Control,
    AcceleratorModifier::Super,
    AcceleratorModifier::Alt,
    AcceleratorModifier::Shift,
];

impl AcceleratorModifier {
    pub fn as_str(self) -> &'static str {
        match self {
            AcceleratorModifier::CommandOrControl => "CommandOrControl",
            AcceleratorModifier::Command => "Command",
            AcceleratorModifier::Control => "Control",
            AcceleratorModifier::Super => "Super",
            AcceleratorModifier::Alt => "Alt",
            AcceleratorModifier::Shift => "Shift",
        }
    }

    /// `MODIFIER_ALIASES`, looked up lower-cased.
    fn from_alias(token: &str) -> Option<Self> {
        Some(match token.to_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" => AcceleratorModifier::CommandOrControl,
            "command" | "cmd" => AcceleratorModifier::Command,
            "control" | "ctrl" => AcceleratorModifier::Control,
            "super" | "meta" => AcceleratorModifier::Super,
            "alt" | "option" => AcceleratorModifier::Alt,
            "shift" => AcceleratorModifier::Shift,
            _ => return None,
        })
    }
}

/// Named keys Electron accepts that a recorder can produce.
const NAMED_KEYS: [&str; 15] = [
    "Space",
    "Tab",
    "Backspace",
    "Delete",
    "Insert",
    "Return",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Escape",
];

/// Punctuation keys, as Electron names them (`+` is spelled `Plus`).
const PUNCTUATION_KEYS: [&str; 11] = ["-", "=", "[", "]", ";", "'", ",", ".", "/", "\\", "`"];

/// Function keys no application binds by default, so they may stand alone.
const BARE_KEYS: [&str; 12] = [
    "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
];

fn canonical_key(token: &str) -> Option<String> {
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return Some(c.to_ascii_uppercase().to_string());
        }
        if c.is_ascii_digit() {
            return Some(c.to_string());
        }
    }
    // /^f([1-9]|1[0-9]|2[0-4])$/i
    if let Some(number) = token.strip_prefix(['f', 'F']) {
        let valid = match number.as_bytes() {
            [d] => (b'1'..=b'9').contains(d),
            [b'1', d] => d.is_ascii_digit(),
            [b'2', d] => (b'0'..=b'4').contains(d),
            _ => false,
        };
        if valid {
            return Some(format!("F{number}"));
        }
    }
    if token.to_lowercase() == "plus" {
        return Some("Plus".into());
    }
    if PUNCTUATION_KEYS.contains(&token) {
        return Some(token.to_string());
    }
    let lower = token.to_lowercase();
    NAMED_KEYS
        .iter()
        .find(|key| key.to_lowercase() == lower)
        .map(|key| key.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAccelerator {
    pub modifiers: Vec<AcceleratorModifier>,
    pub key: String,
}

/// An accelerator split into canonical modifiers and key, or `None` when it
/// is not one this app registers: unknown tokens, a repeated modifier, two
/// keys, no key, or a key that would steal ordinary typing (a bare letter, or
/// one with Shift alone). Alt counts as a modifier here; on macOS
/// Option+letter types a character, which the recorder warns about rather
/// than refuses.
pub fn parse_accelerator(input: &str) -> Option<ParsedAccelerator> {
    let trimmed = js_trim(input);
    if trimmed.is_empty() || utf16_len(trimmed) > 80 {
        return None;
    }
    // `+` separates; a trailing `++` would mean the Plus key, which is spelled `Plus`.
    let tokens: Vec<&str> = trimmed.split('+').map(js_trim).collect();
    if tokens.iter().any(|token| token.is_empty()) {
        return None;
    }

    let mut modifiers: Vec<AcceleratorModifier> = Vec::new();
    let mut key: Option<String> = None;
    for token in tokens {
        if let Some(modifier) = AcceleratorModifier::from_alias(token) {
            if modifiers.contains(&modifier) {
                return None;
            }
            modifiers.push(modifier);
            continue;
        }
        if key.is_some() {
            return None;
        }
        key = Some(canonical_key(token)?);
    }
    let key = key?;
    // CommandOrControl already means one of the two it names.
    if modifiers.contains(&AcceleratorModifier::CommandOrControl)
        && (modifiers.contains(&AcceleratorModifier::Command)
            || modifiers.contains(&AcceleratorModifier::Control))
    {
        return None;
    }

    let ordered: Vec<AcceleratorModifier> = MODIFIER_ORDER
        .into_iter()
        .filter(|m| modifiers.contains(m))
        .collect();
    let has_non_shift = ordered.iter().any(|m| *m != AcceleratorModifier::Shift);
    if !has_non_shift && !BARE_KEYS.contains(&key.as_str()) {
        return None;
    }
    Some(ParsedAccelerator {
        modifiers: ordered,
        key,
    })
}

fn join(modifiers: &[AcceleratorModifier], key: &str) -> String {
    let mut parts: Vec<&str> = modifiers.iter().map(|m| m.as_str()).collect();
    parts.push(key);
    parts.join("+")
}

/// The canonical spelling, or `None` when [`parse_accelerator`] refuses it.
pub fn normalize_accelerator(input: &str) -> Option<String> {
    parse_accelerator(input).map(|parsed| join(&parsed.modifiers, &parsed.key))
}

/// The physical chord an accelerator means on one platform, for telling two
/// bindings apart: `CommandOrControl+K` and `Command+K` are the same keys on a
/// Mac and different ones on Windows. `Super` is the Command key on macOS.
pub fn accelerator_chord(input: &str, platform: &str) -> Option<String> {
    let parsed = parse_accelerator(input)?;
    let mac = platform == "darwin";
    let resolved: Vec<AcceleratorModifier> = parsed
        .modifiers
        .iter()
        .map(|modifier| match modifier {
            AcceleratorModifier::CommandOrControl if mac => AcceleratorModifier::Command,
            AcceleratorModifier::CommandOrControl => AcceleratorModifier::Control,
            AcceleratorModifier::Super if mac => AcceleratorModifier::Command,
            other => *other,
        })
        .collect();
    let ordered: Vec<AcceleratorModifier> = MODIFIER_ORDER
        .into_iter()
        .filter(|m| resolved.contains(m))
        .collect();
    Some(join(&ordered, &parsed.key))
}

/// The action already bound to the same chord, if any. A chord registered
/// twice would run whichever registration the OS kept, so a second binding is
/// refused rather than silently shadowing the first.
pub fn duplicate_shortcut_action(
    bindings: &DesktopShortcutBindings,
    action: DesktopShortcutAction,
    accelerator: &str,
    platform: &str,
) -> Option<DesktopShortcutAction> {
    let chord = accelerator_chord(accelerator, platform)?;
    DesktopShortcutAction::ALL
        .into_iter()
        .filter(|other| *other != action)
        .find(|other| {
            bindings.get(*other).is_some_and(|bound| {
                accelerator_chord(bound, platform).as_deref() == Some(chord.as_str())
            })
        })
}

pub fn is_desktop_shortcut_action(value: &str) -> bool {
    DesktopShortcutAction::parse(value).is_some()
}

/// The `global-hotkey` key code (what `tauri-plugin-global-shortcut` parses)
/// for a canonical key, and whether the key implies Shift.
fn hotkey_code(key: &str) -> Option<(String, bool)> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_uppercase() {
            return Some((format!("Key{c}"), false));
        }
        if c.is_ascii_digit() {
            return Some((format!("Digit{c}"), false));
        }
    }
    if key.len() >= 2 && key.starts_with('F') && key[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Some((key.to_string(), false));
    }
    let code = match key {
        // Electron's `Plus` is the =/+ key with Shift held (its keyboard_util
        // reports it shifted), so the chord is Shift plus the Equal key.
        "Plus" => return Some(("Equal".into(), true)),
        "-" => "Minus",
        "=" => "Equal",
        "[" => "BracketLeft",
        "]" => "BracketRight",
        ";" => "Semicolon",
        "'" => "Quote",
        "," => "Comma",
        "." => "Period",
        "/" => "Slash",
        "\\" => "Backslash",
        "`" => "Backquote",
        "Space" => "Space",
        "Tab" => "Tab",
        "Backspace" => "Backspace",
        "Delete" => "Delete",
        "Insert" => "Insert",
        "Return" => "Enter",
        "Up" => "ArrowUp",
        "Down" => "ArrowDown",
        "Left" => "ArrowLeft",
        "Right" => "ArrowRight",
        "Home" => "Home",
        "End" => "End",
        "PageUp" => "PageUp",
        "PageDown" => "PageDown",
        "Escape" => "Escape",
        _ => return None,
    };
    Some((code.to_string(), false))
}

/// An accelerator in the string `tauri-plugin-global-shortcut` registers
/// (`global_hotkey::hotkey::HotKey::from_str`), or `None` when
/// [`parse_accelerator`] refuses it.
///
/// - `CommandOrControl` stays `CommandOrControl`, which global-hotkey resolves
///   per OS exactly as Electron did (Command on macOS, Control elsewhere).
/// - `Command` and `Super` both become `Super`: Electron gave both the same
///   flag (`EF_COMMAND_DOWN`), the Command key on macOS and the Windows key
///   elsewhere, which is what global-hotkey's `SUPER` is.
/// - Keys use global-hotkey's `Code` names (`KeyA`, `Digit1`, `ArrowUp`,
///   `Enter`, `Backquote`, …), never a bare character the parser might read
///   differently, and `Plus` becomes `Shift+Equal`.
///
/// The memory registrar, `registered()` and the settings file keep the
/// canonical string; only the shell's call into the plugin uses this one.
pub fn tauri_accelerator(accelerator: &str) -> Option<String> {
    let parsed = parse_accelerator(accelerator)?;
    let (code, shifted) = hotkey_code(&parsed.key)?;
    let mut parts: Vec<&str> = Vec::new();
    for modifier in &parsed.modifiers {
        let token = match modifier {
            AcceleratorModifier::CommandOrControl => "CommandOrControl",
            AcceleratorModifier::Command | AcceleratorModifier::Super => "Super",
            AcceleratorModifier::Control => "Control",
            AcceleratorModifier::Alt => "Alt",
            AcceleratorModifier::Shift => "Shift",
        };
        if !parts.contains(&token) {
            parts.push(token);
        }
    }
    if shifted && !parts.contains(&"Shift") {
        parts.push("Shift");
    }
    parts.push(&code);
    Some(parts.join("+"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // electron/src/desktop-shortcuts.test.ts

    #[test]
    fn spells_modifiers_canonically_and_in_a_fixed_order() {
        assert_eq!(
            normalize_accelerator("shift+alt+cmdorctrl+space").as_deref(),
            Some("CommandOrControl+Alt+Shift+Space")
        );
        assert_eq!(
            normalize_accelerator("Option+Cmd+t").as_deref(),
            Some("Command+Alt+T")
        );
        assert_eq!(
            normalize_accelerator("ctrl+meta+f5").as_deref(),
            Some("Control+Super+F5")
        );
        assert_eq!(
            normalize_accelerator("Control+Plus").as_deref(),
            Some("Control+Plus")
        );
        assert_eq!(
            normalize_accelerator("Control+/").as_deref(),
            Some("Control+/")
        );
    }

    #[test]
    fn allows_f13_to_f24_alone_and_nothing_else_without_a_modifier() {
        assert_eq!(normalize_accelerator("F13").as_deref(), Some("F13"));
        assert_eq!(
            normalize_accelerator("shift+F24").as_deref(),
            Some("Shift+F24")
        );
        for bad in ["A", "Shift+A", "F5", "Space", "Shift+Space"] {
            assert_eq!(normalize_accelerator(bad), None, "{bad}");
        }
    }

    #[test]
    fn refuses_what_global_shortcut_would_throw_on_or_misread() {
        let long = format!("Control+{}", "A".repeat(90));
        for bad in [
            "",
            "Control",
            "Control+A+B",
            "Control+Control+A",
            "CommandOrControl+Command+A",
            "Control+Banana",
            "Control++",
            "Hyper+A",
            long.as_str(),
            "Control+F0",
            "Control+F25",
            "Control+F01",
        ] {
            assert_eq!(normalize_accelerator(bad), None, "{bad}");
        }
    }

    #[test]
    fn resolves_command_or_control_and_super_per_platform() {
        assert_eq!(
            accelerator_chord("CommandOrControl+K", "darwin").as_deref(),
            Some("Command+K")
        );
        assert_eq!(
            accelerator_chord("Super+K", "darwin").as_deref(),
            Some("Command+K")
        );
        assert_eq!(
            accelerator_chord("CommandOrControl+K", "win32").as_deref(),
            Some("Control+K")
        );
        assert_eq!(
            accelerator_chord("Super+K", "linux").as_deref(),
            Some("Super+K")
        );
    }

    #[test]
    fn finds_the_action_holding_a_chord() {
        let bindings = DesktopShortcutBindings::defaults();
        assert_eq!(
            duplicate_shortcut_action(
                &bindings,
                DesktopShortcutAction::OpenPalette,
                "Command+Alt+Shift+Space",
                "darwin"
            ),
            Some(DesktopShortcutAction::ToggleTimer)
        );
        assert_eq!(
            duplicate_shortcut_action(
                &bindings,
                DesktopShortcutAction::OpenPalette,
                "Super+Alt+Shift+Space",
                "win32"
            ),
            None
        );
        assert_eq!(
            duplicate_shortcut_action(
                &bindings,
                DesktopShortcutAction::ToggleTimer,
                "CommandOrControl+Alt+Shift+Space",
                "darwin"
            ),
            None,
            "an action never conflicts with itself"
        );
    }

    #[test]
    fn maps_every_key_to_global_hotkey_names() {
        let cases = [
            (
                "CommandOrControl+Alt+Shift+Space",
                "CommandOrControl+Alt+Shift+Space",
            ),
            ("Command+Alt+T", "Super+Alt+KeyT"),
            ("Control+Super+F5", "Control+Super+F5"),
            ("Command+Super+K", "Super+KeyK"),
            ("Control+Plus", "Control+Shift+Equal"),
            ("Control+Shift+Plus", "Control+Shift+Equal"),
            ("Control+7", "Control+Digit7"),
            ("F13", "F13"),
            ("Shift+F24", "Shift+F24"),
            ("Alt+Return", "Alt+Enter"),
            ("Alt+Up", "Alt+ArrowUp"),
            ("Alt+Down", "Alt+ArrowDown"),
            ("Alt+Left", "Alt+ArrowLeft"),
            ("Alt+Right", "Alt+ArrowRight"),
            ("Control+-", "Control+Minus"),
            ("Control+=", "Control+Equal"),
            ("Control+[", "Control+BracketLeft"),
            ("Control+]", "Control+BracketRight"),
            ("Control+;", "Control+Semicolon"),
            ("Control+'", "Control+Quote"),
            ("Control+,", "Control+Comma"),
            ("Control+.", "Control+Period"),
            ("Control+/", "Control+Slash"),
            ("Control+\\", "Control+Backslash"),
            ("Control+`", "Control+Backquote"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                tauri_accelerator(input).as_deref(),
                Some(expected),
                "{input}"
            );
        }
        assert_eq!(tauri_accelerator("Control+Banana"), None);
    }

    /// The tokens `global_hotkey::hotkey::parse_hotkey` (0.7 and 0.8, the
    /// version tauri-plugin-global-shortcut 2.4 uses) accepts, upper-cased as
    /// it compares them. Kept beside the parser's own test below, which runs
    /// the real crate.
    const HOTKEY_MODIFIERS: [&str; 12] = [
        "OPTION",
        "ALT",
        "CONTROL",
        "CTRL",
        "COMMAND",
        "CMD",
        "SUPER",
        "SHIFT",
        "COMMANDORCONTROL",
        "COMMANDORCTRL",
        "CMDORCTRL",
        "CMDORCONTROL",
    ];

    fn every_canonical_key() -> Vec<String> {
        let mut keys: Vec<String> = ('A'..='Z').map(String::from).collect();
        keys.extend(('0'..='9').map(String::from));
        keys.extend((1..=24).map(|n| format!("F{n}")));
        keys.push("Plus".into());
        keys.extend(PUNCTUATION_KEYS.iter().map(|k| k.to_string()));
        keys.extend(NAMED_KEYS.iter().map(|k| k.to_string()));
        keys
    }

    #[test]
    fn every_key_the_grammar_accepts_has_a_mapping() {
        for key in every_canonical_key() {
            let accelerator = format!("Control+Alt+{key}");
            assert!(
                normalize_accelerator(&accelerator).is_some(),
                "{accelerator} parses"
            );
            let mapped =
                tauri_accelerator(&accelerator).unwrap_or_else(|| panic!("{accelerator} maps"));
            let tokens: Vec<&str> = mapped.split('+').collect();
            let (code, modifiers) = tokens.split_last().unwrap();
            for modifier in modifiers {
                assert!(
                    HOTKEY_MODIFIERS.contains(&modifier.to_uppercase().as_str()),
                    "{mapped}"
                );
            }
            assert!(
                !HOTKEY_MODIFIERS.contains(&code.to_uppercase().as_str()),
                "{mapped}: the key comes last"
            );
        }
    }

    #[test]
    fn global_hotkey_parses_every_mapping_to_the_same_chord() {
        use global_hotkey::hotkey::{Code, HotKey, Modifiers};
        use std::str::FromStr;

        for key in every_canonical_key() {
            for prefix in [
                "CommandOrControl+Alt+",
                "Command+Shift+",
                "Control+Super+",
                "",
            ] {
                let accelerator = format!("{prefix}{key}");
                let Some(mapped) = tauri_accelerator(&accelerator) else {
                    assert!(
                        normalize_accelerator(&accelerator).is_none(),
                        "{accelerator}"
                    );
                    continue;
                };
                let hotkey = HotKey::from_str(&mapped).unwrap_or_else(|e| panic!("{mapped}: {e}"));
                let parsed = parse_accelerator(&accelerator).unwrap();
                let mut expected = Modifiers::empty();
                for modifier in &parsed.modifiers {
                    expected |= match modifier {
                        AcceleratorModifier::CommandOrControl => global_hotkey::hotkey::CMD_OR_CTRL,
                        AcceleratorModifier::Command | AcceleratorModifier::Super => {
                            Modifiers::SUPER
                        }
                        AcceleratorModifier::Control => Modifiers::CONTROL,
                        AcceleratorModifier::Alt => Modifiers::ALT,
                        AcceleratorModifier::Shift => Modifiers::SHIFT,
                    };
                }
                if parsed.key == "Plus" {
                    expected |= Modifiers::SHIFT;
                    assert_eq!(hotkey.key, Code::Equal, "{mapped}");
                }
                assert_eq!(hotkey.mods, expected, "{accelerator} → {mapped}");
            }
        }
        assert_eq!(HotKey::from_str("Alt+Enter").unwrap().key, Code::Enter);
        assert_eq!(HotKey::from_str("F24").unwrap().key, Code::F24);
    }
}
