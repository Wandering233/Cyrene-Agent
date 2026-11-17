mod alpha;
mod protocol;
mod stream;
mod output_layout;
mod surface_lifecycle;
mod cursor;
mod touch_input;

use std::{
    env,
    io::{BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use alpha::{Rect, alpha_rects};
use anyhow::{Context, Result, anyhow, bail};
use calloop::{
    EventLoop, LoopSignal,
    channel::{Event as ChannelEvent, Sender, channel},
};
use protocol::{Control, DragPhase, FrameHeader, HostEvent, PointerEventName};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_layer, delegate_output, delegate_pointer, delegate_registry,
    delegate_relative_pointer, delegate_seat, delegate_shm, delegate_touch,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        Capability, SeatHandler, SeatState,
        pointer::{
            PointerData, PointerEvent, PointerEventKind, PointerHandler, ThemeSpec, ThemedPointer,
        },
        relative_pointer::{RelativeMotionEvent, RelativePointerHandler, RelativePointerState},
        touch::{TouchData, TouchHandler},
    },
    shell::{
        WaylandSurface,
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
    },
    shm::{
        Shm, ShmHandler,
        slot::{Buffer, SlotPool},
    },
};
use tracing::{debug, error, info, warn};
use wayland_client::protocol::wl_shm::Format;
use wayland_client::protocol::wl_touch::WlTouch;
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle,
    globals::registry_queue_init,
    protocol::{wl_output, wl_pointer, wl_region, wl_seat, wl_surface},
};
use wayland_protocols::wp::relative_pointer::zv1::client::zwp_relative_pointer_v1::ZwpRelativePointerV1;

const PROTOCOL_VERSION: u32 = 1;
const DEFAULT_WIDTH: u32 = 400;
const DEFAULT_HEIGHT: u32 = 500;
const BUFFER_COUNT: usize = 3;
const INPUT_ALPHA_THRESHOLD: u8 = 10;
const INPUT_REGION_CELL: u32 = 4;

#[derive(Clone)]
struct EventWriter {
    stream: Arc<Mutex<UnixStream>>,
}

impl EventWriter {
    fn new(stream: UnixStream) -> Self {
        Self {
            stream: Arc::new(Mutex::new(stream)),
        }
    }

    fn send(&self, event: &HostEvent) {
        let Ok(mut stream) = self.stream.lock() else {
            return;
        };
        if let Err(err) = serde_json::to_writer(&mut *stream, event) {
            warn!("failed to serialize host event: {err}");
            return;
        }
        if let Err(err) = stream.write_all(b"\n").and_then(|()| stream.flush()) {
            warn!("failed to write host event: {err}");
        }
    }
}

enum Inbound {
    Control(Control),
    Frame(FrameHeader, Vec<u8>),
    Closed,
    ReadError(String),
}

fn main() -> Result<()> {
    if env::args().any(|arg| arg == "--version") {
        println!("cyrene-overlay-host {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cyrene_overlay_host=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let (socket_path, initial_layer) = parse_args()?;
    info!("connecting to Electron socket {}", socket_path.display());
    let stream = connect_with_retry(&socket_path)?;
    let writer = EventWriter::new(stream.try_clone().context("clone socket")?);

    if let Err(err) = run(
        stream.try_clone().context("clone reader socket")?,
        writer.clone(),
        initial_layer,
    ) {
        writer.send(&HostEvent::Error {
            code: "HOST_FAILED".into(),
            message: err.to_string(),
        });
        return Err(err);
    }
    Ok(())
}

fn parse_args() -> Result<(PathBuf, Layer)> {
    let mut socket = None;
    let mut layer = Layer::Top;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => {
                socket = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow!("--socket requires a path"))?,
                ));
            }
            "--layer" => {
                layer = match args.next().as_deref() {
                    Some("overlay") => Layer::Overlay,
                    Some("bottom") => Layer::Bottom,
                    Some("top") | None => Layer::Top,
                    Some(other) => bail!("unknown layer: {other}"),
                };
            }
            "--help" | "-h" => {
                println!(
                    "Usage: cyrene-overlay-host --socket <unix-socket-path> [--layer top|overlay|bottom]"
                );
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
    }
    socket
        .map(|path| (path, layer))
        .ok_or_else(|| anyhow!("missing --socket <unix-socket-path>"))
}

fn connect_with_retry(path: &PathBuf) -> Result<UnixStream> {
    let mut last_err = None;
    for attempt in 0..40 {
        match UnixStream::connect(path) {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                last_err = Some(err);
                if attempt < 39 {
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    Err(anyhow!(
        "could not connect to {}: {}",
        path.display(),
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn spawn_reader(socket: UnixStream, sender: Sender<Inbound>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(socket);
        let mut decoder = stream::Decoder::default();
        loop {
            let inbound = match decoder.next(&mut reader) {
                Ok(Some(stream::Message::Control(control))) => Inbound::Control(control),
                Ok(Some(stream::Message::Frame(header, pixels))) => Inbound::Frame(header, pixels),
                Ok(None) => { let _ = sender.send(Inbound::Closed); return; },
                Err(error) => { let _ = sender.send(Inbound::ReadError(error)); return; },
            };
            if sender.send(inbound).is_err() { return; }
        }
    });
}

fn run(reader_stream: UnixStream, writer: EventWriter, initial_layer: Layer) -> Result<()> {
    let conn = Connection::connect_to_env().context("connect to Wayland display")?;
    let (globals, event_queue) = registry_queue_init(&conn).context("enumerate Wayland globals")?;
    let qh = event_queue.handle();

    let compositor = CompositorState::bind(&globals, &qh)
        .map_err(|err| anyhow!("wl_compositor is unavailable: {err}"))?;
    let layer_shell = match LayerShell::bind(&globals, &qh) {
        Ok(layer_shell) => layer_shell,
        Err(err) => {
            writer.send(&HostEvent::Error {
                code: "LAYER_SHELL_UNAVAILABLE".into(),
                message: format!(
                    "compositor does not implement wlr-layer-shell ({err}); \
                     the GNOME fullscreen fallback is not implemented yet"
                ),
            });
            bail!("wlr-layer-shell is unavailable");
        }
    };
    let shm = Shm::bind(&globals, &qh).map_err(|err| anyhow!("wl_shm is unavailable: {err}"))?;

    let surface = compositor.create_surface(&qh);
    let layer =
        layer_shell.create_layer_surface(&qh, surface, initial_layer, Some("cyrene-overlay"), None);
    layer.set_anchor(Anchor::TOP | Anchor::LEFT);
    layer.set_keyboard_interactivity(KeyboardInteractivity::None);
    layer.set_exclusive_zone(-1);
    layer.set_size(DEFAULT_WIDTH, DEFAULT_HEIGHT);
    layer.set_margin(100, 0, 0, 100);
    layer.commit();

    let mut pool =
        SlotPool::new(pool_size(DEFAULT_WIDTH, DEFAULT_HEIGHT), &shm).context("create shm pool")?;
    let buffers = create_buffers(&mut pool, DEFAULT_WIDTH, DEFAULT_HEIGHT)?;

    let mut event_loop = EventLoop::<Overlay>::try_new().context("create event loop")?;
    let signal = event_loop.get_signal();
    let (sender, channel) = channel::<Inbound>();
    spawn_reader(reader_stream, sender);

    let mut state = Overlay {
        connection: conn.clone(),
        registry_state: RegistryState::new(&globals),
        seat_state: SeatState::new(&globals, &qh),
        output_state: OutputState::new(&globals, &qh),
        relative_pointer_state: RelativePointerState::bind(&globals, &qh),
        shm,
        qh,
        compositor,
        layer_shell,
        layer,
        layer_kind: initial_layer,
        pool,
        buffers,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        buffer_width: DEFAULT_WIDTH,
        buffer_height: DEFAULT_HEIGHT,
        buffer_scale: 1,
        x: 100,
        y: 100,
        visible: false,
        force_interactive: false,
        latest: None,
        last_rects: Vec::new(),
        region_valid: false,
        output: None,
        output_size: (0, 0),
        scale: 1,
        pointer: None,
        touch: None,
        touch_input: touch_input::TouchInput::default(),
        cursor: "default".into(),
        pointer_focused: false,
        themed_pointer: None,
        relative_pointer: None,
        drag: None,
        writer,
        signal,
        quit: false,
        ready_sent: false,
        initialized: false,
        surface_lifecycle: surface_lifecycle::SurfaceLifecycle::default(),
        last_frame_seq: None,
        acked_seq: None,
    };

    {
        let handle = event_loop.handle();
        smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource::new(
            conn.clone(),
            event_queue,
        )
        .insert(handle.clone())
        .map_err(|err| anyhow!("insert Wayland source: {err}"))?;
        handle
            .insert_source(channel, |event, _, state| {
                if let ChannelEvent::Msg(inbound) = event {
                    state.handle_inbound(inbound);
                }
            })
            .map_err(|err| anyhow!("insert socket channel: {err}"))?;
    }

    info!("overlay host running");
    event_loop
        .run(None, &mut state, |_| {})
        .map_err(|err| anyhow!("event loop failed: {err}"))?;
    Ok(())
}

fn pool_size(width: u32, height: u32) -> usize {
    width as usize * height as usize * 4 * BUFFER_COUNT
}

fn create_buffers(pool: &mut SlotPool, width: u32, height: u32) -> Result<Vec<Buffer>> {
    let mut buffers = Vec::with_capacity(BUFFER_COUNT);
    let stride = (width * 4) as i32;
    for _ in 0..BUFFER_COUNT {
        let (buffer, _) = pool
            .create_buffer(width as i32, height as i32, stride, Format::Argb8888)
            .map_err(|err| anyhow!("create shm buffer: {err}"))?;
        buffers.push(buffer);
    }
    Ok(buffers)
}

struct DragState {
    button: u32,
    start_x: i32,
    start_y: i32,
    accum_x: f64,
    accum_y: f64,
    started: bool,
    pointer_start: (f64, f64),
}

struct Overlay {
    connection: Connection,
    registry_state: RegistryState,
    seat_state: SeatState,
    output_state: OutputState,
    relative_pointer_state: RelativePointerState,
    shm: Shm,
    qh: QueueHandle<Overlay>,
    compositor: CompositorState,
    layer_shell: LayerShell,
    layer: LayerSurface,
    layer_kind: Layer,
    pool: SlotPool,
    buffers: Vec<Buffer>,
    width: u32,
    height: u32,
    buffer_width: u32,
    buffer_height: u32,
    buffer_scale: i32,
    x: i32,
    y: i32,
    visible: bool,
    force_interactive: bool,
    latest: Option<(FrameHeader, Vec<u8>)>,
    last_rects: Vec<Rect>,
    region_valid: bool,
    output: Option<wl_output::WlOutput>,
    output_size: (i32, i32),
    scale: i32,
    pointer: Option<wl_pointer::WlPointer>,
    touch: Option<WlTouch>,
    touch_input: touch_input::TouchInput,
    cursor: String,
    pointer_focused: bool,
    themed_pointer: Option<ThemedPointer>,
    relative_pointer: Option<ZwpRelativePointerV1>,
    drag: Option<DragState>,
    writer: EventWriter,
    signal: LoopSignal,
    quit: bool,
    ready_sent: bool,
    initialized: bool,
    surface_lifecycle: surface_lifecycle::SurfaceLifecycle,
    last_frame_seq: Option<u64>,
    acked_seq: Option<u64>,
}

impl Overlay {
    fn handle_inbound(&mut self, inbound: Inbound) {
        match inbound {
            Inbound::Control(control) => self.handle_control(control),
            Inbound::Frame(header, pixels) => self.handle_frame(header, pixels),
            Inbound::Closed => {
                info!("Electron socket closed");
                self.stop();
            }
            Inbound::ReadError(message) => {
                error!("{message}");
                self.writer.send(&HostEvent::Error {
                    code: "SOCKET_READ_FAILED".into(),
                    message,
                });
                self.stop();
            }
        }
    }

    fn handle_control(&mut self, control: Control) {
        match control {
            Control::Init {
                protocol,
                scale,
                width,
                height,
                x,
                y,
                output,
            } => {
                if let Some(version) = protocol {
                    if version != PROTOCOL_VERSION {
                        self.writer.send(&HostEvent::Error {
                            code: "PROTOCOL_MISMATCH".into(),
                            message: format!(
                                "host protocol {PROTOCOL_VERSION}, Electron protocol {version}"
                            ),
                        });
                        self.stop();
                        return;
                    }
                }
                debug!("init {width}x{height} scale={scale:?} at ({x},{y}) output={output:?}");
                self.x = x;
                self.y = y;
                if let Some(scale) = scale {
                    self.buffer_scale = scale.max(1);
                }
                self.resize(width, height);
                self.initialized = true;
                if let Some(output) = output {
                    self.switch_output(&output);
                }
                self.clamp_position();
                self.apply_margins();
                self.layer.commit();
                self.send_position();
                if !self.ready_sent {
                    self.send_ready();
                }
            }
            Control::Size { width, height } => {
                self.resize(width, height);
                self.clamp_position();
                self.apply_margins();
                self.layer.set_size(self.width, self.height);
                self.layer.commit();
                self.send_position();
            }
            Control::Move { x, y } => {
                self.x = x;
                self.y = y;
                self.clamp_position();
                self.apply_margins();
                self.layer.commit();
                self.send_position();
            }
            Control::Show => {
                if self.visible { return; }
                self.visible = true;
                self.region_valid = false;
                // Unmapping resets layer-shell state. Reapply it and issue an
                // empty commit before waiting for a fresh configure.
                self.layer.set_anchor(Anchor::TOP | Anchor::LEFT);
                self.layer.set_keyboard_interactivity(KeyboardInteractivity::None);
                self.layer.set_exclusive_zone(-1);
                self.layer.set_layer(self.layer_kind);
                self.layer.set_size(self.width, self.height);
                self.apply_margins();
                self.layer.commit();
                self.draw();
            }
            Control::Hide => {
                if !self.visible { return; }
                self.cancel_touch();
                self.cancel_drag();
                self.pointer_focused = false;
                self.visible = false;
                self.surface_lifecycle.replaced();
                self.region_valid = false;
                self.update_input_region();
                self.layer.wl_surface().attach(None, 0, 0);
                self.layer.commit();
            }
            Control::Interactive { interactive } => {
                self.force_interactive = interactive;
                self.region_valid = false;
                self.update_input_region();
                self.layer.commit();
            }
            Control::Cursor { cursor } => {
                self.cursor = cursor;
                if self.pointer_focused {
                    if let Some(pointer) = &self.themed_pointer { cursor::apply(pointer, &self.connection, &self.cursor); }
                }
            }
            Control::Layer { layer } => {
                let target = match layer.as_str() {
                    "overlay" => Layer::Overlay,
                    "top" | "" => Layer::Top,
                    "bottom" => Layer::Bottom,
                    other => {
                        warn!("unknown layer {other:?}; keeping current layer");
                        return;
                    }
                };
                self.layer_kind = target;
                self.layer.set_layer(target);
                self.layer.commit();
            }
            Control::Quit => self.stop(),
        }
    }

    fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        let scale = self.buffer_scale.max(1) as u32;
        let buffer_width = width.saturating_mul(scale);
        let buffer_height = height.saturating_mul(scale);
        if width == self.width
            && height == self.height
            && buffer_width == self.buffer_width
            && buffer_height == self.buffer_height
        {
            return;
        }
        self.width = width;
        self.height = height;
        self.buffer_width = buffer_width;
        self.buffer_height = buffer_height;
        info!(
            "resize {}x{} logical -> {}x{} buffer (scale {})",
            self.width, self.height, self.buffer_width, self.buffer_height, self.buffer_scale
        );
        self.layer.set_size(self.width, self.height);
        self.layer
            .wl_surface()
            .set_buffer_scale(self.buffer_scale.max(1));
        match self.reset_pool() {
            Ok(()) => {
                self.latest = None;
                self.last_rects.clear();
                self.region_valid = false;
            }
            Err(err) => {
                self.writer.send(&HostEvent::Error {
                    code: "BUFFER_RESIZE_FAILED".into(),
                    message: err.to_string(),
                });
            }
        }
    }

    fn reset_pool(&mut self) -> Result<()> {
        // Drop buffers before replacing the pool: Buffer holds a Slot that
        // points into the old pool's memory.
        self.buffers.clear();
        self.pool = SlotPool::new(pool_size(self.buffer_width, self.buffer_height), &self.shm)
            .context("resize shm pool")?;
        self.buffers = create_buffers(&mut self.pool, self.buffer_width, self.buffer_height)?;
        Ok(())
    }

    fn handle_frame(&mut self, header: FrameHeader, pixels: Vec<u8>) {
        self.last_frame_seq = Some(header.seq);
        if header.width == 0 || header.height == 0 {
            return;
        }
        if header.width != self.buffer_width || header.height != self.buffer_height {
            warn!(
                "frame {}x{} does not match buffer {}x{} (logical {}x{} scale {})",
                header.width,
                header.height,
                self.buffer_width,
                self.buffer_height,
                self.width,
                self.height,
                self.buffer_scale
            );
            return;
        }
        self.latest = Some((header, pixels));
        if self.visible {
            self.draw();
        }
    }

    fn draw(&mut self) {
        if !self.visible || !self.surface_lifecycle.can_attach() {
            return;
        }
        self.update_input_region();

        let Some((header, pixels)) = self.latest.as_ref() else {
            return;
        };
        if header.width != self.buffer_width || header.height != self.buffer_height {
            return;
        }

        let mut attached = false;
        {
            let pool = &mut self.pool;
            let width = self.buffer_width as usize;
            let height = self.buffer_height as usize;
            let stride = header.stride as usize;
            if stride < width * 4 || pixels.len() < stride * height {
                return;
            }

            for buffer in &self.buffers {
                let Some(canvas) = pool.canvas(buffer) else {
                    continue;
                };
                let row_bytes = width * 4;
                for y in 0..height {
                    let src = &pixels[y * stride..y * stride + row_bytes];
                    let dst = &mut canvas[y * row_bytes..y * row_bytes + row_bytes];
                    dst.copy_from_slice(src);
                }
                if buffer.attach_to(self.layer.wl_surface()).is_err() {
                    continue;
                }
                self.layer.wl_surface().damage_buffer(
                    0,
                    0,
                    self.buffer_width as i32,
                    self.buffer_height as i32,
                );
                self.layer.commit();
                attached = true;
                break;
            }
        }

        if !attached {
            debug!("all shm buffers are busy; dropping a frame");
        } else {
            self.ack_frame();
        }
    }

    fn update_input_region(&mut self) {
        let surface = self.layer.wl_surface();
        if !self.visible {
            let region = self.compositor.wl_compositor().create_region(&self.qh, ());
            surface.set_input_region(Some(&region));
            region.destroy();
            self.region_valid = true;
            return;
        }

        if self.force_interactive {
            surface.set_input_region(None);
            self.region_valid = true;
            return;
        }

        let scale = self.buffer_scale.max(1);
        let rects = match self.latest.as_ref() {
            Some((header, pixels)) => alpha_rects(
                pixels,
                header.width,
                header.height,
                header.stride as usize,
                INPUT_ALPHA_THRESHOLD,
                (if self.width.saturating_mul(self.height) > 300_000 {
                    6
                } else {
                    INPUT_REGION_CELL
                }) * scale as u32,
            )
            .into_iter()
            .map(|rect| Rect {
                x: rect.x / scale,
                y: rect.y / scale,
                width: ((rect.width + scale - 1) / scale).max(1),
                height: ((rect.height + scale - 1) / scale).max(1),
            })
            .collect(),
            None => Vec::new(),
        };

        if self.region_valid && rects == self.last_rects {
            return;
        }

        let region = self.compositor.wl_compositor().create_region(&self.qh, ());
        for rect in &rects {
            region.add(rect.x, rect.y, rect.width, rect.height);
        }
        surface.set_input_region(Some(&region));
        region.destroy();
        self.last_rects = rects;
        self.region_valid = true;
    }

    fn apply_margins(&self) {
        self.layer.set_margin(self.y, 0, 0, self.x);
    }

    fn ack_frame(&mut self) {
        if let Some(seq) = self.last_frame_seq {
            if self.acked_seq != Some(seq) {
                self.acked_seq = Some(seq);
                self.writer.send(&HostEvent::FrameAck { seq });
            }
        }
    }

    fn clamp_position(&mut self) {
        let (out_w, out_h) = self.output_size;
        if out_w <= 0 || out_h <= 0 {
            return;
        }
        let max_x = (out_w - self.width as i32).max(0);
        let max_y = (out_h - self.height as i32).max(0);
        self.x = self.x.clamp(0, max_x);
        self.y = self.y.clamp(0, max_y);
    }

    fn switch_output(&mut self, name: &str) {
        if name.is_empty() {
            return;
        }
        let target = self.output_state.outputs().find(|output| {
            self.output_state
                .info(output)
                .and_then(|info| info.name)
                .as_deref()
                == Some(name)
        });
        let Some(output) = target else {
            warn!("requested output {name:?} not found; keeping current output");
            return;
        };
        if self.output.as_ref() == Some(&output) {
            return;
        }
        self.set_output(output);
        info!("switched overlay to output {name}");
    }

    fn set_output(&mut self, output: wl_output::WlOutput) {
        self.cancel_touch();
        self.pointer_focused = false;
        // An output can disappear during the implicit grab. Release the
        // renderer's drag state before retiring the old surface.
        self.cancel_drag();
        let surface = self.compositor.create_surface(&self.qh);
        let layer = self.layer_shell.create_layer_surface(
            &self.qh,
            surface,
            self.layer_kind,
            Some("cyrene-overlay"),
            Some(&output),
        );
        layer.set_anchor(Anchor::TOP | Anchor::LEFT);
        layer.set_keyboard_interactivity(KeyboardInteractivity::None);
        layer.set_exclusive_zone(-1);
        layer.set_size(self.width, self.height);
        layer.set_margin(self.y, 0, 0, self.x);
        layer
            .wl_surface()
            .set_buffer_scale(self.buffer_scale.max(1));
        layer.commit();

        self.layer = layer;
        self.surface_lifecycle.replaced();
        self.output = Some(output.clone());
        if let Some(info) = self.output_state.info(&output) {
            if let Some((w, h)) = info.logical_size {
                self.output_size = (w, h);
            }
            self.scale = info.scale_factor.max(1);
        }
        self.region_valid = false;
        self.clamp_position();
        self.apply_margins();
        self.layer.commit();
        self.send_position();
    }

    fn finish_drag(&mut self, drag: &DragState) {
        let origin = self.output.as_ref().and_then(|output| self.output_state.info(output))
            .and_then(|info| info.logical_position).unwrap_or((0, 0));
        let pointer = (origin.0 as f64 + drag.start_x as f64 + drag.pointer_start.0 + drag.accum_x,
            origin.1 as f64 + drag.start_y as f64 + drag.pointer_start.1 + drag.accum_y);
        let global = (origin.0 + drag.start_x + drag.accum_x.round() as i32,
            origin.1 + drag.start_y + drag.accum_y.round() as i32);
        let outputs: Vec<_> = self.output_state.outputs().filter_map(|output| {
            let info = self.output_state.info(&output)?;
            let (x, y) = info.logical_position?; let (width, height) = info.logical_size?;
            Some(output_layout::OutputRect { output, x, y, width, height })
        }).collect();
        if let Some(target) = output_layout::target_output(&outputs, pointer).cloned() {
            let target_origin = self.output_state.info(&target).and_then(|info| info.logical_position).unwrap_or((0, 0));
            self.x = global.0 - target_origin.0; self.y = global.1 - target_origin.1;
            if self.output.as_ref() != Some(&target) { self.set_output(target); }
        } else {
            self.x = global.0 - origin.0; self.y = global.1 - origin.1;
        }
        self.clamp_position(); self.apply_margins(); self.layer.commit(); self.send_position();
    }

    fn send_ready(&mut self) {
        if self.ready_sent {
            return;
        }
        self.ready_sent = true;
        let output = self
            .output
            .as_ref()
            .and_then(|output| self.output_state.info(output).and_then(|info| info.name));
        self.writer.send(&HostEvent::Ready {
            protocol: PROTOCOL_VERSION,
            version: env!("CARGO_PKG_VERSION").to_string(),
            width: self.width,
            height: self.height,
            output,
            scale: self.buffer_scale,
        });
    }

    fn send_position(&self) {
        if !self.initialized {
            return;
        }
        let info = self.output.as_ref().and_then(|output| self.output_state.info(output));
        let origin = info.as_ref().and_then(|info| info.logical_position).unwrap_or((0, 0));
        let output_scale = info.as_ref().map(|info| info.scale_factor.max(1)).unwrap_or(1);
        self.writer.send(&HostEvent::Position {
            x: self.x,
            y: self.y,
            output: info.and_then(|info| info.name),
            output_x: origin.0,
            output_y: origin.1,
            scale: output_scale,
        });
    }

    fn send_pointer(
        &self,
        event: PointerEventName,
        x: f64,
        y: f64,
        button: Option<u32>,
        time: Option<u32>,
    ) {
        self.writer.send(&HostEvent::Pointer {
            event,
            x,
            y,
            button,
            time,
            delta_x: None,
            delta_y: None,
        });
    }

    fn send_touch(&self, event: touch_input::TouchEvent, time: Option<u32>) {
        let (x, y) = event.position;
        if event.event == PointerEventName::Down {
            self.send_pointer(PointerEventName::Enter, x, y, None, time);
            self.send_pointer(PointerEventName::Motion, x, y, None, time);
        }
        let button = if event.event == PointerEventName::Motion { None } else { Some(0x110) };
        self.send_pointer(event.event, x, y, button, time);
        if event.event == PointerEventName::Up { self.send_pointer(PointerEventName::Leave, x, y, None, time); }
    }

    fn cancel_touch(&mut self) {
        if let Some(event) = self.touch_input.cancel() { self.send_touch(event, None); }
    }

    fn cancel_drag(&mut self) {
        if let Some(drag) = self.drag.take() {
            self.send_pointer(PointerEventName::Cancel, drag.pointer_start.0, drag.pointer_start.1, Some(drag.button), None);
            if drag.started { self.writer.send(&HostEvent::Drag { phase: DragPhase::End, x: self.x, y: self.y }); }
        }
    }

    fn send_axis(&self, x: f64, y: f64, time: u32, delta_x: f64, delta_y: f64) {
        self.writer.send(&HostEvent::Pointer {
            event: PointerEventName::Axis,
            x,
            y,
            button: None,
            time: Some(time),
            delta_x: Some(delta_x),
            delta_y: Some(delta_y),
        });
    }

    fn stop(&mut self) {
        if self.quit {
            return;
        }
        self.quit = true;
        self.signal.stop();
    }
}

impl CompositorHandler for Overlay {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        surface: &wl_surface::WlSurface,
        new_factor: i32,
    ) {
        if surface != self.layer.wl_surface() { return; }
        self.scale = new_factor.max(1);
        self.send_position();
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        surface: &wl_surface::WlSurface,
        output: &wl_output::WlOutput,
    ) {
        if surface != self.layer.wl_surface() { return; }
        if self.output.as_ref().is_some_and(|selected| selected != output) { return; }
        self.output = Some(output.clone());
        if let Some(info) = self.output_state.info(output) {
            if let Some((w, h)) = info.logical_size {
                self.output_size = (w, h);
            }
            self.scale = info.scale_factor.max(1);
            debug!(
                "surface entered output {:?} size={:?}",
                info.name, info.logical_size
            );
        }
        self.send_position();
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        output: &wl_output::WlOutput,
    ) {
        // 保留选定输出身份；output_destroyed 负责迁移，leave 可能先于销毁到达。
        let _ = output;
    }
}

impl OutputHandler for Overlay {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}

    fn update_output(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        if self.output.as_ref() == Some(&output) {
            if let Some(info) = self.output_state.info(&output) {
                if let Some((w, h)) = info.logical_size {
                    self.output_size = (w, h);
                }
                self.scale = info.scale_factor.max(1);
            }
            self.clamp_position();
            self.apply_margins();
            self.layer.commit();
            self.send_position();
        }
    }

    fn output_destroyed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        if self.output.as_ref() != Some(&output) {
            return;
        }
        self.output = None;
        let replacement = self
            .output_state
            .outputs()
            .find(|candidate| candidate != &output);
        match replacement {
            Some(next) => {
                warn!("current output disappeared; moving overlay to the next output");
                self.set_output(next);
            }
            None => {
                warn!("current output disappeared and no output remains");
                self.stop();
            }
        }
    }
}

impl LayerShellHandler for Overlay {
    fn closed(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, layer: &LayerSurface) {
        if layer.wl_surface() != self.layer.wl_surface() { return; }
        if let Some(output) = self.output.clone() {
            let replacement = self.output_state.outputs().find(|candidate| candidate != &output);
            if let Some(next) = replacement {
                self.set_output(next);
                return;
            }
        }
        self.stop();
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _serial: u32,
    ) {
        if layer.wl_surface() != self.layer.wl_surface() { return; }
        self.surface_lifecycle.configured();
        let (w, h) = configure.new_size;
        if w > 0 && h > 0 && (w != self.width || h != self.height) {
            self.resize(w, h);
        }
        if !self.ready_sent {
            self.send_ready();
        }
        if self.visible {
            self.draw();
        }
    }
}

impl SeatHandler for Overlay {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}

    fn new_capability(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Touch && self.touch.is_none() {
            if let Ok(touch) = self.seat_state.get_touch(qh, &seat) {
                self.touch = Some(touch);
            }
        }
        if capability == Capability::Pointer && self.pointer.is_none() {
            let surface = self.compositor.create_surface(qh);
            if let Ok(themed) = self.seat_state.get_pointer_with_theme(
                qh,
                &seat,
                self.shm.wl_shm(),
                surface,
                ThemeSpec::default(),
            ) {
                self.pointer = Some(themed.pointer().clone());
                self.themed_pointer = Some(themed);
                self.relative_pointer = self
                    .relative_pointer_state
                    .get_relative_pointer(self.pointer.as_ref().unwrap(), qh)
                    .ok();
            }
        }
    }

    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Touch && self.touch.as_ref().and_then(|touch| touch.data::<TouchData>()).is_some_and(|data| data.seat() == &seat) {
            self.cancel_touch();
            if let Some(touch) = self.touch.take() { if touch.version() >= 3 { touch.release(); } }
        }
        if capability == Capability::Pointer && self.pointer.as_ref().and_then(|pointer| pointer.data::<PointerData>()).is_some_and(|data| data.seat() == &seat) {
            self.cancel_drag();
            self.pointer_focused = false;
            if let Some(relative) = self.relative_pointer.take() { relative.destroy(); }
            self.pointer = None;
            // ThemedPointer owns and releases wl_pointer; releasing the clone as well is a protocol error.
            self.themed_pointer = None;
        }
    }

    fn remove_seat(&mut self, conn: &Connection, qh: &QueueHandle<Self>, seat: wl_seat::WlSeat) {
        self.remove_capability(conn, qh, seat.clone(), Capability::Touch);
        self.remove_capability(conn, qh, seat, Capability::Pointer);
    }
}

impl PointerHandler for Overlay {
    fn pointer_frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for event in events {
            if &event.surface != self.layer.wl_surface() {
                continue;
            }
            let (x, y) = event.position;
            match event.kind {
                PointerEventKind::Enter { .. } => {
                    self.pointer_focused = true;
                    if let Some(pointer) = &self.themed_pointer { cursor::apply(pointer, _conn, &self.cursor); }
                    self.send_pointer(PointerEventName::Enter, x, y, None, None);
                }
                PointerEventKind::Leave { .. } => {
                    self.pointer_focused = false;
                    self.send_pointer(PointerEventName::Leave, x, y, None, None);
                    // Implicit pointer grab remains active until button release.
                }
                PointerEventKind::Motion { time } => {
                    self.send_pointer(PointerEventName::Motion, x, y, None, Some(time));
                }
                PointerEventKind::Press { time, button, .. } => {
                    self.send_pointer(PointerEventName::Down, x, y, Some(button), Some(time));
                    if button == 0x110 {
                        self.drag = Some(DragState {
                            button,
                            start_x: self.x,
                            start_y: self.y,
                            accum_x: 0.0,
                            accum_y: 0.0,
                            started: false,
                            pointer_start: (x, y),
                        });
                    }
                }
                PointerEventKind::Release { time, button, .. } => {
                    self.send_pointer(PointerEventName::Up, x, y, Some(button), Some(time));
                    if self.drag.as_ref().is_some_and(|drag| drag.button == button) {
                        if let Some(drag) = self.drag.take() {
                            if drag.started {
                                self.finish_drag(&drag);
                                self.writer.send(&HostEvent::Drag { phase: DragPhase::End, x: self.x, y: self.y });
                            }
                        }
                    }
                }
                PointerEventKind::Axis {
                    time,
                    horizontal,
                    vertical,
                    ..
                } => {
                    let dx = if horizontal.absolute != 0.0 {
                        horizontal.absolute
                    } else {
                        horizontal.discrete as f64 * 15.0
                    };
                    let dy = if vertical.absolute != 0.0 {
                        vertical.absolute
                    } else {
                        vertical.discrete as f64 * 15.0
                    };
                    self.send_axis(x, y, time, dx, dy);
                }
            }
        }
    }
}

impl RelativePointerHandler for Overlay {
    fn relative_pointer_motion(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _relative_pointer: &ZwpRelativePointerV1,
        _pointer: &wl_pointer::WlPointer,
        event: RelativeMotionEvent,
    ) {
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        drag.accum_x += event.delta.0;
        drag.accum_y += event.delta.1;

        if !drag.started && (drag.accum_x.abs() >= 2.0 || drag.accum_y.abs() >= 2.0) {
            drag.started = true;
            self.writer.send(&HostEvent::Drag {
                phase: DragPhase::Start,
                x: self.x,
                y: self.y,
            });
        }
        if !drag.started {
            return;
        }

        let (start_x, start_y, accum_x, accum_y) =
            (drag.start_x, drag.start_y, drag.accum_x, drag.accum_y);
        self.x = start_x + accum_x.round() as i32;
        self.y = start_y + accum_y.round() as i32;
        self.clamp_position();
        self.apply_margins();
        self.layer.commit();
        self.writer.send(&HostEvent::Drag {
            phase: DragPhase::Move,
            x: self.x,
            y: self.y,
        });
    }
}

impl ShmHandler for Overlay {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

impl ProvidesRegistryState for Overlay {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
}

impl Dispatch<wl_region::WlRegion, ()> for Overlay {
    fn event(
        _state: &mut Self,
        _proxy: &wl_region::WlRegion,
        _event: <wl_region::WlRegion as wayland_client::Proxy>::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
    }
}

impl TouchHandler for Overlay {
    fn down(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlTouch,
        _: u32,
        time: u32,
        surface: wl_surface::WlSurface,
        id: i32,
        position: (f64, f64),
    ) {
        if !self.visible || &surface != self.layer.wl_surface() {
            return;
        }
        if let Some(event) = self.touch_input.down(id, position) { self.send_touch(event, Some(time)); }
    }

    fn up(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlTouch,
        _: u32,
        time: u32,
        id: i32,
    ) {
        if let Some(event) = self.touch_input.up(id) { self.send_touch(event, Some(time)); }
    }

    fn motion(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlTouch,
        time: u32,
        id: i32,
        position: (f64, f64),
    ) {
        if let Some(event) = self.touch_input.motion(id, position) { self.send_touch(event, Some(time)); }
    }

    fn cancel(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch) { self.cancel_touch(); }
    fn shape(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlTouch,
        _: i32,
        _: f64,
        _: f64,
    ) {
    }
    fn orientation(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch, _: i32, _: f64) {}
}

delegate_compositor!(Overlay);
delegate_output!(Overlay);
delegate_shm!(Overlay);
delegate_seat!(Overlay);
delegate_pointer!(Overlay);
delegate_relative_pointer!(Overlay);
delegate_layer!(Overlay);
delegate_touch!(Overlay);
delegate_registry!(Overlay);
