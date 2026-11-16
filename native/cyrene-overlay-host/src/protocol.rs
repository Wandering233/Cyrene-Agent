use serde::{Deserialize, Serialize};

/// Control messages sent by the Electron main process over the Unix socket.
///
/// The wire format is one JSON object per line. `Frame` messages are special:
/// their JSON header line is immediately followed by exactly `stride * height`
/// bytes of BGRA pixel data.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Control {
    Init {
        #[serde(default)]
        protocol: Option<u32>,
        #[serde(default)]
        scale: Option<i32>,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
        #[serde(default)]
        output: Option<String>,
    },
    Size {
        width: u32,
        height: u32,
    },
    Move {
        x: i32,
        y: i32,
    },
    Show,
    Hide,
    Interactive {
        interactive: bool,
    },
    Layer {
        layer: String,
    },
    Quit,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FrameHeader {
    #[serde(default)]
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
}

impl FrameHeader {
    pub fn byte_len(&self) -> Option<usize> {
        let stride = self.stride as usize;
        let height = self.height as usize;
        if stride < self.width as usize * 4 {
            return None;
        }
        stride.checked_mul(height)
    }
}

/// Messages sent by the host back to Electron.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostEvent {
    FrameAck {
        seq: u64,
    },
    Ready {
        protocol: u32,
        width: u32,
        height: u32,
        output: Option<String>,
        scale: i32,
    },
    Pointer {
        event: PointerEventName,
        x: f64,
        y: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        button: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        time: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        delta_x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        delta_y: Option<f64>,
    },
    Drag {
        phase: DragPhase,
        x: i32,
        y: i32,
    },
    Position {
        x: i32,
        y: i32,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerEventName {
    Enter,
    Leave,
    Motion,
    Down,
    Up,
    Axis,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DragPhase {
    Start,
    Move,
    End,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_init() {
        let c: Control = serde_json::from_str(
            r#"{"type":"init","width":400,"height":500,"x":12,"y":34,"output":"HDMI-A-1"}"#,
        )
        .unwrap();
        match c {
            Control::Init {
                width,
                height,
                x,
                y,
                output,
                ..
            } => {
                assert_eq!((width, height, x, y), (400, 500, 12, 34));
                assert_eq!(output.as_deref(), Some("HDMI-A-1"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_frame_header_and_checks_stride() {
        let h: FrameHeader =
            serde_json::from_str(r#"{"type":"frame","width":10,"height":5,"stride":48}"#).unwrap();
        assert_eq!(h.byte_len(), Some(240));
        let bad: FrameHeader =
            serde_json::from_str(r#"{"type":"frame","width":10,"height":5,"stride":8}"#).unwrap();
        assert_eq!(bad.byte_len(), None);
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    #[test]
    fn rejects_frame_headers_with_overflowing_stride() {
        let header = FrameHeader {
            seq: 0,
            width: u32::MAX,
            height: u32::MAX,
            stride: u32::MAX,
        };
        assert!(header.byte_len().is_none());
    }

    #[test]
    fn rejects_zero_or_short_headers() {
        let header = FrameHeader { seq: 0, width: 4, height: 2, stride: 0 };
        assert!(header.byte_len().is_none());
        assert!(serde_json::from_str::<Control>(r#"{"type":"size","width":0,"height":4}"#).is_ok());
    }
}

#[cfg(test)]
mod fuzz_tests {
    use super::*;

    #[test]
    fn arbitrary_json_never_panics() {
        // Deterministic pseudo-random byte strings; parsing must return Err or
        // a valid message, never panic.
        let mut seed: u64 = 0x9e3779b97f4a7c15;
        for _ in 0..2000 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let len = (seed as usize % 96) + 1;
            let mut bytes = vec![0u8; len];
            for b in &mut bytes {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                *b = (seed >> 33) as u8;
            }
            let text = String::from_utf8_lossy(&bytes);
            let _ = serde_json::from_str::<Control>(&text);
            let _ = serde_json::from_str::<FrameHeader>(&text);
        }
    }

    #[test]
    fn frame_headers_bound_dimensions() {
        for (w, h, stride) in [(0u32, 1u32, 0u32), (1, 0, 4), (u32::MAX, 2, u32::MAX)] {
            let header = FrameHeader { seq: 0, width: w, height: h, stride };
            let _ = header.byte_len();
        }
    }
}
