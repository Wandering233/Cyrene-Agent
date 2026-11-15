# cyrene-overlay-host

Native Wayland overlay host for Cyrene's pet window.

The Electron pet renderer runs in a hidden offscreen `BrowserWindow` and
streams premultiplied BGRA frames to this process over a Unix socket. The host
owns the real Wayland surface:

- `zwlr_layer_shell_v1` (wlroots, Hyprland, KDE Plasma, COSMIC, Mir);
- `wl_shm` ARGB8888 buffers;
- `wl_surface.set_input_region` computed from frame alpha;
- pointer events forwarded back to Electron via `webContents.sendInputEvent`;
- dragging via `zwp_relative_pointer_v1` deltas and layer-shell margins.

It deliberately has no X11 dependency and no Electron fork.

## Build

```bash
cargo build --release --manifest-path native/cyrene-overlay-host/Cargo.toml
# or, from the repo root, stage it for packaging:
pnpm run build:overlay-host
```

## Run

Electron starts the host automatically on Linux/Wayland when the binary is
available. Manual invocation is only useful for debugging:

```bash
cyrene-overlay-host --socket /tmp/cyrene-overlay.sock
```

Electron is the Unix-socket server; the host connects back.

## Protocol

Newline-delimited JSON control messages:

```json
{"type":"init","width":400,"height":500,"x":100,"y":100}
{"type":"move","x":200,"y":200}
{"type":"size","width":500,"height":625}
{"type":"show"}
{"type":"hide"}
{"type":"interactive","interactive":false}
{"type":"quit"}
```

A frame is a JSON header line followed by exactly `stride * height` bytes:

```json
{"type":"frame","width":400,"height":500,"stride":1600}
```

The host sends `ready`, `pointer`, `drag`, `position`, `error` and `log`
events. See `src/protocol.rs` for the exact shapes.

## Limitations

- Requires `zwlr_layer_shell_v1`; GNOME/Mutter does not implement it. The
  fullscreen fallback for GNOME is not part of this host yet.
- Always-on-top currently uses the layer-shell `TOP` layer; the setting is
  recorded by Electron but not mapped to `OVERLAY` yet.
- HiDPI: frames are rendered at logical size and the compositor scales the
  buffer. Per-output buffer scale is a follow-up.
- Drag uses relative-pointer accelerated deltas; compositors without
  `zwp_relative_pointer_v1` will report a warning and cannot drag.
