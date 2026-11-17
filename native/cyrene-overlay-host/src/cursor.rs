use smithay_client_toolkit::seat::pointer::{CursorIcon, ThemedPointer};
use wayland_client::Connection;

/// Chromium names differ from the cursor-shape/CSS names for a few icons.
pub fn icon(name: &str) -> CursorIcon {
    match name {
        "hand" => CursorIcon::Pointer,
        "ibeam" => CursorIcon::Text,
        "nodrop" | "drag-drop-none" => CursorIcon::NoDrop,
        "drag-drop-move" => CursorIcon::Move,
        "drag-drop-copy" => CursorIcon::Copy,
        "drag-drop-link" => CursorIcon::Alias,
        "ns-no-resize" | "ew-no-resize" | "nesw-no-resize" | "nwse-no-resize" => {
            CursorIcon::NotAllowed
        }
        "m-panning" => CursorIcon::AllScroll,
        _ => name.parse().unwrap_or(CursorIcon::Default),
    }
}

pub fn apply(pointer: &ThemedPointer, conn: &Connection, name: &str) {
    if name == "none" {
        if let Err(error) = pointer.hide_cursor() {
            tracing::warn!("hide cursor: {error}");
        }
        return;
    }
    if let Err(error) = pointer.set_cursor(conn, icon(name)) {
        tracing::warn!("cursor {name}: {error}; trying default");
        let _ = pointer.set_cursor(conn, CursorIcon::Default);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_names_and_unsupported_custom_images_have_safe_fallbacks() {
        assert_eq!(icon("hand"), CursorIcon::Pointer);
        assert_eq!(icon("ibeam"), CursorIcon::Text);
        assert_eq!(icon("grab"), CursorIcon::Grab);
        assert_eq!(icon("nwse-resize"), CursorIcon::NwseResize);
        assert_eq!(icon("drag-drop-link"), CursorIcon::Alias);
        assert_eq!(icon("custom"), CursorIcon::Default);
        assert_eq!(icon("not-a-theme-path"), CursorIcon::Default);
    }
}
