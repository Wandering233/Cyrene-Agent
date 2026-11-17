//! Fullscreen transparent overlay fallback for compositors without
//! wlr-layer-shell (notably GNOME/Mutter).
//!
//! A standard xdg_toplevel is made fullscreen on one output. The surface is a
//! transparent full-output shm buffer; the pet frame is copied into it at
//! (x, y), and the input region is restricted to the pet's alpha shape. This
//! gives positioning, always-on-top (fullscreen stacking) and click-through
//! without any layer-shell extension.

#[path = "../alpha.rs"]
mod alpha;
#[path = "../protocol.rs"]
mod protocol;
#[path = "../stream.rs"]
mod stream;
#[path = "../cursor.rs"]
mod cursor;
#[path = "../touch_input.rs"]
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
use protocol::{Control, FrameHeader, HostEvent, PointerEventName};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_output, delegate_pointer, delegate_registry,
    delegate_relative_pointer, delegate_seat, delegate_shm, delegate_touch, delegate_xdg_shell,
    delegate_xdg_window,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        Capability, SeatHandler, SeatState,
        pointer::{PointerData, PointerEvent, PointerEventKind, PointerHandler, ThemeSpec, ThemedPointer},
        relative_pointer::{RelativeMotionEvent, RelativePointerHandler, RelativePointerState},
        touch::{TouchData, TouchHandler},
    },
    shell::{
        WaylandSurface,
        xdg::{
            XdgShell,
            window::{Window, WindowConfigure, WindowDecorations, WindowHandler},
        },
    },
    shm::{
        Shm, ShmHandler,
        slot::{Buffer, SlotPool},
    },
};
use tracing::{info, warn};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle,
    globals::registry_queue_init,
    protocol::{wl_output, wl_pointer, wl_region, wl_seat, wl_shm, wl_surface, wl_touch::WlTouch},
};
use wayland_protocols::wp::relative_pointer::zv1::client::zwp_relative_pointer_v1::ZwpRelativePointerV1;

const PROTOCOL_VERSION: u32 = 1;
const ALPHA_THRESHOLD: u8 = 10;
const REGION_CELL: u32 = 4;
const BUFFER_COUNT: usize = 2;

#[derive(Clone)]
struct EventWriter {
    stream: Arc<Mutex<UnixStream>>,
}
impl EventWriter {
    fn send(&self, event: &HostEvent) {
        let Ok(mut stream) = self.stream.lock() else {
            return;
        };
        if serde_json::to_writer(&mut *stream, event).is_ok() {
            let _ = stream.write_all(b"\n").and_then(|()| stream.flush());
        }
    }
}

enum Inbound {
    Control(Control),
    Frame(FrameHeader, Vec<u8>),
    Closed,
    Error(String),
}

fn main() -> Result<()> {
    if env::args().any(|arg| arg == "--version") {
        println!("cyrene-overlay-fullscreen {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cyrene_overlay_fullscreen=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let socket = parse_socket_path()?;
    let stream = connect_with_retry(&socket)?;
    let writer = EventWriter {
        stream: Arc::new(Mutex::new(stream.try_clone()?)),
    };
    run(stream, writer)
}

fn parse_socket_path() -> Result<PathBuf> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--socket" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| anyhow!("--socket requires a path"));
        }
    }
    bail!("missing --socket <path>")
}

fn connect_with_retry(path: &PathBuf) -> Result<UnixStream> {
    let mut last = None;
    for _ in 0..40 {
        match UnixStream::connect(path) {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                last = Some(err);
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Err(anyhow!(
        "could not connect to {}: {}",
        path.display(),
        last.map(|e| e.to_string()).unwrap_or_default()
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
                Err(error) => { let _ = sender.send(Inbound::Error(error)); return; },
            };
            if sender.send(inbound).is_err() { return; }
        }
    });
}

fn run(reader: UnixStream, writer: EventWriter) -> Result<()> {
    let conn = Connection::connect_to_env().context("connect Wayland")?;
    let (globals, event_queue) = registry_queue_init(&conn)?;
    let qh = event_queue.handle();
    let compositor = CompositorState::bind(&globals, &qh)?;
    let xdg = match XdgShell::bind(&globals, &qh) {
        Ok(xdg) => xdg,
        Err(err) => {
            writer.send(&HostEvent::Error {
                code: "XDG_SHELL_UNAVAILABLE".into(),
                message: err.to_string(),
            });
            bail!("xdg shell unavailable");
        }
    };
    let shm = Shm::bind(&globals, &qh)?;
    let surface = compositor.create_surface(&qh);
    let window = xdg.create_window(surface, WindowDecorations::ClientOnly, &qh);
    window.set_title("Cyrene Pet Overlay");
    window.set_app_id("com.cyrene.live2d");
    window.set_fullscreen(None);
    window.commit();

    let mut event_loop = EventLoop::<State>::try_new()?;
    let signal = event_loop.get_signal();
    let (sender, channel) = channel::<Inbound>();
    spawn_reader(reader, sender);
    let mut state = State {
        connection: conn.clone(),
        registry_state: RegistryState::new(&globals),
        seat_state: SeatState::new(&globals, &qh),
        output_state: OutputState::new(&globals, &qh),
        relative_pointer_state: RelativePointerState::bind(&globals, &qh),
        shm,
        qh,
        compositor,
        window,
        pool: None,
        buffers: Vec::new(),
        screen_w: 0,
        screen_h: 0,
        pet_w: 400,
        pet_h: 500,
        x: 100,
        y: 100,
        scale: 1,
        visible: false,
        latest: None,
        last_pet: None,
        pointer: None,
        themed_pointer: None,
        cursor: "default".into(),
        pointer_focused: false,
        touch: None,
        touch_input: touch_input::TouchInput::default(),
        relative_pointer: None,
        drag: None,
        writer,
        signal,
        quit: false,
        ready_sent: false,
        initialized: false,
        output: None,
        fullscreen_requested: false,
    };
    {
        let handle = event_loop.handle();
        smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource::new(
            conn.clone(),
            event_queue,
        )
        .insert(handle.clone())
        .map_err(|e| anyhow!("wayland source: {e}"))?;
        handle
            .insert_source(channel, |event, _, state| {
                if let ChannelEvent::Msg(inbound) = event {
                    state.inbound(inbound);
                }
            })
            .map_err(|e| anyhow!("socket source: {e}"))?;
    }
    info!("fullscreen overlay host running");
    event_loop.run(None, &mut state, |_| {})?;
    Ok(())
}

struct State {
    connection: Connection,
    registry_state: RegistryState,
    seat_state: SeatState,
    output_state: OutputState,
    relative_pointer_state: RelativePointerState,
    shm: Shm,
    qh: QueueHandle<State>,
    compositor: CompositorState,
    window: Window,
    pool: Option<SlotPool>,
    buffers: Vec<Buffer>,
    screen_w: u32,
    screen_h: u32,
    pet_w: u32,
    pet_h: u32,
    x: i32,
    y: i32,
    scale: i32,
    visible: bool,
    latest: Option<(FrameHeader, Vec<u8>)>,
    last_pet: Option<Rect>,
    pointer: Option<wl_pointer::WlPointer>,
    themed_pointer: Option<ThemedPointer>,
    cursor: String,
    pointer_focused: bool,
    touch: Option<WlTouch>,
    touch_input: touch_input::TouchInput,
    relative_pointer: Option<ZwpRelativePointerV1>,
    drag: Option<Drag>,
    writer: EventWriter,
    signal: LoopSignal,
    quit: bool,
    ready_sent: bool,
    initialized: bool,
    output: Option<wl_output::WlOutput>,
    fullscreen_requested: bool,
}

struct Drag {
    button: u32,
    start_x: i32,
    start_y: i32,
    accum_x: f64,
    accum_y: f64,
    started: bool,
}

impl State {
    fn inbound(&mut self, inbound: Inbound) {
        match inbound {
            Inbound::Control(control) => self.control(control),
            Inbound::Frame(header, pixels) => self.frame(header, pixels),
            Inbound::Closed => self.stop(),
            Inbound::Error(message) => {
                self.writer.send(&HostEvent::Error {
                    code: "SOCKET_READ_FAILED".into(),
                    message,
                });
                self.stop();
            }
        }
    }

    fn control(&mut self, control: Control) {
        match control {
            Control::Init {
                protocol,
                width,
                height,
                x,
                y,
                output,
                ..
            } => {
                if let Some(version) = protocol {
                    if version != PROTOCOL_VERSION {
                        self.writer.send(&HostEvent::Error {
                            code: "PROTOCOL_MISMATCH".into(),
                            message: format!("host {PROTOCOL_VERSION}, client {version}"),
                        });
                        self.stop();
                        return;
                    }
                }
                self.pet_w = width.max(1);
                self.pet_h = height.max(1);
                self.x = x;
                self.y = y;
                self.initialized = true;
                if let Some(name) = output {
                    if let Some(target) = self.output_state.outputs().find(|o| {
                        self.output_state.info(o).and_then(|i| i.name).as_deref() == Some(name.as_str())
                    }) {
                        self.cancel_touch();
                        self.output = Some(target);
                        self.window.set_fullscreen(self.output.as_ref());
                        self.window.commit();
                    }
                }
                self.clamp();
                self.redraw();
                if !self.ready_sent {
                    self.ready();
                }
            }
            Control::Size { width, height } => {
                self.pet_w = width.max(1);
                self.pet_h = height.max(1);
                self.latest = None;
                self.redraw();
            }
            Control::Move { x, y } => {
                self.x = x;
                self.y = y;
                self.clamp();
                self.redraw();
                self.position();
            }
            Control::Show => {
                self.visible = true;
                self.redraw();
            }
            Control::Hide => {
                self.cancel_touch();
                self.cancel_drag();
                self.pointer_focused = false;
                self.visible = false;
                self.window.wl_surface().attach(None, 0, 0);
                self.window.commit();
            }
            Control::Interactive { .. } | Control::Layer { .. } => {}
            Control::Cursor { cursor } => {
                self.cursor = cursor;
                if self.pointer_focused {
                    if let Some(pointer) = &self.themed_pointer { cursor::apply(pointer, &self.connection, &self.cursor); }
                }
            }
            Control::Quit => self.stop(),
        }
    }

    fn clamp(&mut self) {
        if self.screen_w == 0 || self.screen_h == 0 {
            return;
        }
        self.x = self
            .x
            .clamp(0, (self.screen_w as i32 - self.pet_w as i32).max(0));
        self.y = self
            .y
            .clamp(0, (self.screen_h as i32 - self.pet_h as i32).max(0));
    }

    fn ready(&mut self) {
        if self.ready_sent {
            return;
        }
        self.ready_sent = true;
        let name = self
            .output
            .as_ref()
            .and_then(|o| self.output_state.info(o).and_then(|i| i.name));
        self.writer.send(&HostEvent::Ready {
            protocol: PROTOCOL_VERSION,
            version: env!("CARGO_PKG_VERSION").to_string(),
            width: self.pet_w,
            height: self.pet_h,
            output: name,
            scale: self.scale,
        });
        self.position();
    }

    fn position(&self) {
        if !self.initialized { return; }
        let info = self.output.as_ref().and_then(|output| self.output_state.info(output));
        let origin = info.as_ref().and_then(|info| info.logical_position).unwrap_or((0, 0));
        self.writer.send(&HostEvent::Position {
            x: self.x,
            y: self.y,
            output: info.and_then(|info| info.name),
            output_x: origin.0,
            output_y: origin.1,
            scale: 1,
        });
    }

    fn frame(&mut self, header: FrameHeader, pixels: Vec<u8>) {
        if header.width == 0 || header.height == 0 {
            return;
        }
        self.pet_w = header.width;
        self.pet_h = header.height;
        self.latest = Some((header, pixels));
        self.redraw();
    }

    fn ensure_pool(&mut self) {
        if self.pool.is_some() && self.screen_w > 0 && self.screen_h > 0 {
            return;
        }
        let stride = self.screen_w as usize * 4;
        if stride == 0 || self.screen_h == 0 {
            return;
        }
        let len = stride * self.screen_h as usize;
        match SlotPool::new(len * BUFFER_COUNT, &self.shm) {
            Ok(mut pool) => {
                let mut buffers = Vec::with_capacity(BUFFER_COUNT);
                for _ in 0..BUFFER_COUNT {
                    match pool.create_buffer(
                        self.screen_w as i32,
                        self.screen_h as i32,
                        stride as i32,
                        wl_shm::Format::Argb8888,
                    ) {
                        Ok((buffer, _)) => buffers.push(buffer),
                        Err(err) => {
                            warn!("buffer: {err}");
                            return;
                        }
                    }
                }
                self.buffers = buffers;
                self.pool = Some(pool);
            }
            Err(err) => warn!("pool: {err}"),
        }
    }

    fn redraw(&mut self) {
        if !self.visible || self.screen_w == 0 || self.screen_h == 0 {
            return;
        }
        self.ensure_pool();
        let Some(pool) = self.pool.as_mut() else {
            return;
        };
        let Some((header, pixels)) = self.latest.as_ref() else {
            // Map the transparent fullscreen surface even before the first pet frame.
            for buffer in &self.buffers {
                if buffer.attach_to(self.window.wl_surface()).is_ok() {
                    self.window.commit();
                    break;
                }
            }
            return;
        };
        let pet_rect = Rect {
            x: self.x,
            y: self.y,
            width: self.pet_w as i32,
            height: self.pet_h as i32,
        };
        let mut chosen: Option<&Buffer> = None;
        for buffer in &self.buffers {
            if pool.canvas(buffer).is_some() {
                chosen = Some(buffer);
                break;
            }
        }
        let Some(buffer) = chosen else { return };
        let Some(canvas) = pool.canvas(buffer) else {
            return;
        };
        // Clear the previous pet area (full-output buffer starts transparent).
        if let Some(old) = self.last_pet {
            for row in 0..old.height.max(0) as usize {
                let y = old.y as usize + row;
                if y >= self.screen_h as usize {
                    break;
                }
                let start = (y * self.screen_w as usize + old.x.max(0) as usize) * 4;
                let end = start + old.width.max(0) as usize * 4;
                if end <= canvas.len() {
                    canvas[start..end].fill(0);
                }
            }
        }
        let rects: Vec<Rect> = alpha_rects(
            pixels,
            self.pet_w,
            self.pet_h,
            header.stride as usize,
            ALPHA_THRESHOLD,
            REGION_CELL,
        )
        .into_iter()
        .map(|r| Rect {
            x: r.x + self.x,
            y: r.y + self.y,
            width: r.width,
            height: r.height,
        })
        .collect();
        let stride = header.stride as usize;
        let copy_w = (self.pet_w as usize).min(self.screen_w as usize);
        let copy_h = (self.pet_h as usize).min(self.screen_h as usize);
        for row in 0..copy_h {
            let dst_y = self.y.max(0) as usize + row;
            if dst_y >= self.screen_h as usize {
                break;
            }
            let src = row * stride;
            let dst = (dst_y * self.screen_w as usize + self.x.max(0) as usize) * 4;
            if src + copy_w * 4 <= pixels.len() && dst + copy_w * 4 <= canvas.len() {
                canvas[dst..dst + copy_w * 4].copy_from_slice(&pixels[src..src + copy_w * 4]);
            }
        }
        self.last_pet = Some(pet_rect);
        buffer.attach_to(self.window.wl_surface()).ok();
        self.window.wl_surface().damage_buffer(
            pet_rect.x.max(0),
            pet_rect.y.max(0),
            pet_rect.width,
            pet_rect.height,
        );
        self.window.commit();
        if !self.fullscreen_requested {
            // Some compositors only honour fullscreen once the surface has a
            // mapped buffer. Ask after the first real frame, then the next
            // configure carries the fullscreen size.
            self.fullscreen_requested = true;
            self.window.set_fullscreen(self.output.as_ref());
            self.window.commit();
        }
        let _ = (header, pixels);
        self.apply_input_rects(rects);
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
            self.send_pointer(PointerEventName::Cancel, self.x as f64, self.y as f64, Some(drag.button), None);
            if drag.started { self.writer.send(&HostEvent::Drag { phase: protocol::DragPhase::End, x: self.x, y: self.y }); }
        }
    }

    fn apply_input_rects(&mut self, rects: Vec<Rect>) {
        let region = self.compositor.wl_compositor().create_region(&self.qh, ());
        for r in &rects {
            region.add(r.x, r.y, r.width, r.height);
        }
        self.window.wl_surface().set_input_region(Some(&region));
        region.destroy();
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
            x: x - self.x as f64,
            y: y - self.y as f64,
            button,
            time,
            delta_x: None,
            delta_y: None,
        });
    }

    fn stop(&mut self) {
        if !self.quit {
            self.quit = true;
            self.signal.stop();
        }
    }
}

impl CompositorHandler for State {
    fn scale_factor_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        factor: i32,
    ) {
        self.scale = factor.max(1);
    }
    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: wl_output::Transform,
    ) {
    }
    fn frame(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &wl_surface::WlSurface, _: u32) {}
    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        output: &wl_output::WlOutput,
    ) {
        self.output = Some(output.clone());
        self.position();
    }
    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_surface::WlSurface,
        _: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for State {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }
    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
}

impl WindowHandler for State {
    fn request_close(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &Window) {
        self.stop();
    }
    fn configure(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &Window,
        configure: WindowConfigure,
        _: u32,
    ) {
        let width = configure.new_size.0.map(|v| v.get()).unwrap_or(1920);
        let height = configure.new_size.1.map(|v| v.get()).unwrap_or(1080);
        self.screen_w = width;
        self.screen_h = height;
        self.buffers.clear();
        self.pool = None;
        self.last_pet = None;
        self.ensure_pool();
        if let Some(pool) = self.pool.as_mut() {
            if let Some(buffer) = self.buffers.first() {
                // Ensure a transparent frame maps the fullscreen surface.
                if let Some(canvas) = pool.canvas(buffer) {
                    canvas.fill(0);
                }
                let _ = buffer.attach_to(self.window.wl_surface());
                self.window
                    .wl_surface()
                    .damage_buffer(0, 0, width as i32, height as i32);
                self.window.commit();
            }
        }
        self.clamp();
        self.redraw();
        self.position();
        if !self.ready_sent {
            self.ready();
        }
    }
}

impl SeatHandler for State {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }
    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {}
    fn new_capability(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Touch && self.touch.is_none() {
            self.touch = self.seat_state.get_touch(qh, &seat).ok();
        }
        if capability == Capability::Pointer && self.pointer.is_none() {
            let surface = self.compositor.create_surface(qh);
            if let Ok(themed) = self.seat_state.get_pointer_with_theme(qh, &seat, self.shm.wl_shm(), surface, ThemeSpec::default()) {
                let pointer = themed.pointer().clone();
                self.relative_pointer = self
                    .relative_pointer_state
                    .get_relative_pointer(&pointer, qh)
                    .ok();
                self.pointer = Some(pointer);
                self.themed_pointer = Some(themed);
            }
        }
    }
    fn remove_capability(
        &mut self,
        _: &Connection,
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
            self.themed_pointer = None;
        }
    }
    fn remove_seat(&mut self, conn: &Connection, qh: &QueueHandle<Self>, seat: wl_seat::WlSeat) {
        self.remove_capability(conn, qh, seat.clone(), Capability::Touch);
        self.remove_capability(conn, qh, seat, Capability::Pointer);
    }
}

impl PointerHandler for State {
    fn pointer_frame(
        &mut self,
        conn: &Connection,
        _: &QueueHandle<Self>,
        _: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for event in events {
            if &event.surface != self.window.wl_surface() {
                continue;
            }
            let (x, y) = event.position;
            match event.kind {
                PointerEventKind::Enter { .. } => {
                    self.pointer_focused = true;
                    if let Some(pointer) = &self.themed_pointer { cursor::apply(pointer, conn, &self.cursor); }
                    self.send_pointer(PointerEventName::Enter, x, y, None, None)
                }
                PointerEventKind::Leave { .. } => {
                    self.pointer_focused = false;
                    self.send_pointer(PointerEventName::Leave, x, y, None, None);
                }
                PointerEventKind::Motion { time } => {
                    self.send_pointer(PointerEventName::Motion, x, y, None, Some(time))
                }
                PointerEventKind::Press { time, button, .. } => {
                    self.send_pointer(PointerEventName::Down, x, y, Some(button), Some(time));
                    if button == 0x110 {
                        self.drag = Some(Drag {
                            button,
                            start_x: self.x,
                            start_y: self.y,
                            accum_x: 0.0,
                            accum_y: 0.0,
                            started: false,
                        });
                    }
                }
                PointerEventKind::Release { time, button, .. } => {
                    if self.drag.as_ref().is_some_and(|drag| drag.button == button) {
                        if self.drag.take().is_some_and(|drag| drag.started) {
                            self.writer.send(&HostEvent::Drag {
                                phase: protocol::DragPhase::End,
                                x: self.x,
                                y: self.y,
                            });
                            self.position();
                        }
                    }
                    self.send_pointer(PointerEventName::Up, x, y, Some(button), Some(time));
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
                    self.writer.send(&HostEvent::Pointer {
                        event: PointerEventName::Axis,
                        x: x - self.x as f64,
                        y: y - self.y as f64,
                        button: None,
                        time: Some(time),
                        delta_x: Some(dx),
                        delta_y: Some(dy),
                    });
                }
            }
        }
    }
}

impl TouchHandler for State {
    fn down(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch, _: u32,
        time: u32, surface: wl_surface::WlSurface, id: i32, position: (f64, f64)) {
        if !self.visible || &surface != self.window.wl_surface() { return; }
        if let Some(event) = self.touch_input.down(id, position) { self.send_touch(event, Some(time)); }
    }
    fn up(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch, _: u32, time: u32, id: i32) {
        if let Some(event) = self.touch_input.up(id) { self.send_touch(event, Some(time)); }
    }
    fn motion(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch, time: u32, id: i32, position: (f64, f64)) {
        if let Some(event) = self.touch_input.motion(id, position) { self.send_touch(event, Some(time)); }
    }
    fn cancel(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch) { self.cancel_touch(); }
    fn shape(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch, _: i32, _: f64, _: f64) {}
    fn orientation(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlTouch, _: i32, _: f64) {}
}

impl RelativePointerHandler for State {
    fn relative_pointer_motion(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &ZwpRelativePointerV1,
        _: &wl_pointer::WlPointer,
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
                phase: protocol::DragPhase::Start,
                x: self.x,
                y: self.y,
            });
        }
        if !drag.started {
            return;
        }
        let (sx, sy, ax, ay) = (drag.start_x, drag.start_y, drag.accum_x, drag.accum_y);
        self.x = sx + ax.round() as i32;
        self.y = sy + ay.round() as i32;
        self.clamp();
        self.redraw();
        self.writer.send(&HostEvent::Drag {
            phase: protocol::DragPhase::Move,
            x: self.x,
            y: self.y,
        });
    }
}

impl ShmHandler for State {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}
impl ProvidesRegistryState for State {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
}
impl Dispatch<wl_region::WlRegion, ()> for State {
    fn event(
        _: &mut Self,
        _: &wl_region::WlRegion,
        _: <wl_region::WlRegion as wayland_client::Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

delegate_compositor!(State);
delegate_output!(State);
delegate_shm!(State);
delegate_seat!(State);
delegate_pointer!(State);
delegate_touch!(State);
delegate_relative_pointer!(State);
delegate_xdg_shell!(State);
delegate_xdg_window!(State);
delegate_registry!(State);
