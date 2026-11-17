use std::io::{BufRead, Read};
use serde_json::Value;
use crate::protocol::{Control, FrameHeader};

const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;
#[derive(Debug)]
pub enum Message { Control(Control), Frame(FrameHeader, Vec<u8>) }
#[derive(Default)]
pub struct Decoder { initialized: bool, scale: u32, last_seq: Option<u64> }
impl Decoder {
    pub fn next(&mut self, reader: &mut impl BufRead) -> Result<Option<Message>, String> {
        let mut line = Vec::new();
        let bytes = reader.take((MAX_LINE_BYTES + 1) as u64).read_until(b'\n', &mut line)
            .map_err(|e| format!("socket read failed: {e}"))?;
        if bytes == 0 { return Ok(None); }
        if bytes > MAX_LINE_BYTES { return Err("socket line too long".into()); }
        if line.last() != Some(&b'\n') { return Err("truncated control line".into()); }
        let value: Value = serde_json::from_slice(&line).map_err(|e| format!("invalid JSON: {e}"))?;
        if value.get("type").and_then(Value::as_str) == Some("frame") {
            if !self.initialized { return Err("frame before init".into()); }
            let header: FrameHeader = serde_json::from_value(value).map_err(|e| format!("invalid frame header: {e}"))?;
            if self.last_seq.is_some_and(|seq| header.seq <= seq) { return Err("frame sequence out of order".into()); }
            let len = header.byte_len().filter(|len| *len <= MAX_FRAME_BYTES).ok_or("invalid frame dimensions/stride")?;
            let mut pixels = vec![0; len];
            reader.read_exact(&mut pixels).map_err(|e| format!("truncated frame: {e}"))?;
            self.last_seq = Some(header.seq);
            return Ok(Some(Message::Frame(header, pixels)));
        }
        let control: Control = serde_json::from_value(value).map_err(|e| format!("invalid control: {e}"))?;
        match &control {
            Control::Init { width, height, scale, .. } => {
                let scale = scale.unwrap_or(1);
                if !(1..=8).contains(&scale) || !valid_size(*width, *height, scale as u32) {
                    return Err("invalid init dimensions/scale".into());
                }
                self.initialized = true;
                self.scale = scale as u32;
            }
            Control::Quit => {},
            _ if !self.initialized => return Err("control before init".into()),
            Control::Size { width, height } if !valid_size(*width, *height, self.scale) => return Err("invalid size".into()),
            _ => {},
        }
        Ok(Some(Message::Control(control)))
    }
}
fn valid_size(width: u32, height: u32, scale: u32) -> bool {
    width > 0 && height > 0 && width <= 16384 && height <= 16384
        && (width as u64 * height as u64 * scale as u64 * scale as u64 * 4) <= MAX_FRAME_BYTES as u64
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};
    const INIT: &[u8] = b"{\"type\":\"init\",\"protocol\":1,\"width\":2,\"height\":1,\"x\":0,\"y\":0}\n";
    fn decode(data: Vec<u8>) -> Result<Vec<Message>, String> {
        let mut reader = BufReader::with_capacity(1, Cursor::new(data));
        let mut decoder = Decoder::default(); let mut out = Vec::new();
        while let Some(msg) = decoder.next(&mut reader)? { out.push(msg); }
        Ok(out)
    }
    fn frame(seq: u64) -> Vec<u8> {
        let mut bytes = format!("{{\"type\":\"frame\",\"seq\":{seq},\"width\":2,\"height\":1,\"stride\":8}}\n").into_bytes();
        bytes.extend_from_slice(&[0, 10, 255, 255, 13, 0, 255, 255]); bytes
    }
    #[test] fn fragmented_and_coalesced_binary_frames_keep_boundaries() {
        let bytes = [INIT, &frame(0), &frame(1), b"{\"type\":\"quit\"}\n"].concat();
        let msgs = decode(bytes).unwrap(); assert_eq!(msgs.len(), 4);
        assert!(matches!(&msgs[1], Message::Frame(h, p) if h.seq == 0 && p.len() == 8 && p[1] == 10));
    }
    #[test] fn truncated_payload_is_rejected() {
        let mut bytes = [INIT, &frame(0)].concat(); bytes.pop();
        assert!(decode(bytes).unwrap_err().contains("truncated frame"));
    }
    #[test] fn frame_before_init_and_duplicate_sequence_are_rejected() {
        assert!(decode(frame(0)).unwrap_err().contains("before init"));
        assert!(decode([INIT, &frame(1), &frame(1)].concat()).unwrap_err().contains("out of order"));
        assert!(decode([INIT, &frame(2), &frame(1)].concat()).unwrap_err().contains("out of order"));
    }
    #[test] fn oversized_or_unterminated_lines_are_rejected() {
        assert!(decode(vec![b'x'; MAX_LINE_BYTES + 2]).unwrap_err().contains("too long"));
        assert!(decode(b"{\"type\":\"quit\"}".to_vec()).unwrap_err().contains("truncated"));
    }
    #[test] fn invalid_dimensions_and_scale_are_rejected_before_allocation() {
        for text in [r#"{"type":"init","width":0,"height":1,"x":0,"y":0}"#,
            r#"{"type":"init","width":16384,"height":16384,"x":0,"y":0}"#,
            r#"{"type":"init","width":1,"height":1,"x":0,"y":0,"scale":999}"#] {
            assert!(decode(format!("{text}\n").into_bytes()).is_err());
        }
    }
    #[test] fn invalid_binary_header_fails_closed() {
        let bad = b"{\"type\":\"frame\",\"width\":1,\"height\":0,\"stride\":4}\n";
        assert!(decode([INIT, bad].concat()).is_err());
        assert!(decode([INIT, b"{\"type\":\"show\"}\n"].concat()).is_ok());
    }
    #[test] fn deterministic_stream_fuzz_never_panics() {
        let mut seed = 9u64;
        for n in 0..2000 {
            let mut bytes = INIT.to_vec();
            for _ in 0..(n % 100) { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1); bytes.push((seed >> 32) as u8); }
            bytes.push(b'\n'); let _ = decode(bytes);
        }
    }
}
