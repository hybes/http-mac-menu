// Rise, fall and warning are decided while a value is formatted but shown much
// later, so the formatter leaves a control character behind and this module
// turns it into a glyph wherever text is drawn — menu items, tooltips, the
// tray title, the log and the clipboard. Control characters are used because
// they cannot appear in a real response or in a user's template.

pub const MARK_RISE: char = '\u{0001}';
pub const MARK_FALL: char = '\u{0002}';
pub const MARK_WARN: char = '\u{0003}';

pub fn is_mark(c: char) -> bool {
    c == MARK_RISE || c == MARK_FALL || c == MARK_WARN
}

/// The styles offered in the tray menu, in menu order. 1.x drew these as
/// icons; here each is a pair of characters the system font already has, so
/// the choice still shows up wherever a value does.
pub const STYLES: [(&str, &str); 4] = [
    ("chevron", "Chevron"),
    ("arrow", "Arrow"),
    ("triangle", "Triangle"),
    ("text", "Text"),
];

pub const DEFAULT_STYLE: &str = "chevron";

pub fn normalize_style(id: &str) -> String {
    if STYLES.iter().any(|(known, _)| *known == id) {
        id.to_string()
    } else {
        DEFAULT_STYLE.to_string()
    }
}

/// Warnings look the same in every style; only rise and fall change.
pub fn glyph(mark: char, style: &str) -> char {
    match mark {
        MARK_WARN => '⚠',
        MARK_RISE => match style {
            "arrow" => '↑',
            "triangle" => '▲',
            "chevron" => '⌃',
            _ => '▴',
        },
        MARK_FALL => match style {
            "arrow" => '↓',
            "triangle" => '▼',
            "chevron" => '⌄',
            _ => '▾',
        },
        _ => ' ',
    }
}

/// The fixed pair used everywhere the style does not apply. 1.x drew icons in
/// the menu bar only; its menu items, tooltips and clipboard always used these.
pub fn text_glyph(mark: char) -> char {
    glyph(mark, "text")
}

/// The menu bar title, which is where the chosen style shows up.
pub fn to_text_styled(value: &str, style: &str) -> String {
    value
        .chars()
        .map(|c| if is_mark(c) { glyph(c, style) } else { c })
        .collect()
}

/// Everywhere else: menu items, tooltips, the log, the clipboard and the
/// widget snapshot, none of which follow the style.
pub fn to_text(value: &str) -> String {
    to_text_styled(value, "text")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_style_has_its_own_pair() {
        let pairs: Vec<(char, char)> = STYLES
            .iter()
            .map(|(id, _)| (glyph(MARK_RISE, id), glyph(MARK_FALL, id)))
            .collect();
        assert_eq!(pairs.len(), 4);
        for (rise, fall) in &pairs {
            assert_ne!(rise, fall);
        }
        // Chevron and arrow must not collapse into the same rendering.
        assert_ne!(pairs[0], pairs[1]);
    }

    #[test]
    fn warnings_ignore_the_style() {
        for (id, _) in STYLES {
            assert_eq!(glyph(MARK_WARN, id), '⚠');
        }
    }

    #[test]
    fn only_the_tray_title_follows_the_style() {
        let raw = format!("{MARK_RISE}12.30");
        assert_eq!(to_text_styled(&raw, "arrow"), "↑12.30");
        // Menus, tooltips and the clipboard keep the fixed pair.
        assert_eq!(to_text(&raw), "▴12.30");
    }

    #[test]
    fn unknown_styles_fall_back() {
        assert_eq!(normalize_style("nope"), DEFAULT_STYLE);
        assert_eq!(normalize_style("arrow"), "arrow");
    }
}
