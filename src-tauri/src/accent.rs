// The settings form paints its primary button, its focus rings and the
// selected segment in the system accent colour. 1.x read it with
// systemPreferences.getAccentColor(); this is the same lookup, and the same
// `rrggbbaa` string, so the renderer did not have to change.
//
// Everywhere but macOS there is no such setting, and the UI keeps its blue.

#[cfg(target_os = "macos")]
pub fn accent_color() -> Option<String> {
    use objc2_app_kit::{NSColor, NSColorSpace};

    let accent = NSColor::controlAccentColor();
    // A catalog colour has no components until it is resolved against a real
    // colour space, and returns None if it cannot be.
    let srgb = accent.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
    let channel = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    let (r, g, b) = (
        channel(srgb.redComponent()),
        channel(srgb.greenComponent()),
        channel(srgb.blueComponent()),
    );
    Some(format!("{r:02x}{g:02x}{b:02x}ff"))
}

#[cfg(not(target_os = "macos"))]
pub fn accent_color() -> Option<String> {
    None
}
