/// One rectangle of the input region, in surface-local pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Convert a BGRA frame into a conservative input region.
///
/// A cell is considered opaque if any pixel in it has alpha >= `threshold`.
/// We deliberately over-approximate: a click on a very faint anti-aliased
/// pixel is better than a visible pixel that cannot be clicked.
///
/// The resulting rectangles are merged vertically where possible to keep the
/// `wl_region` small (compositors have to hit-test it on every pointer move).
pub fn alpha_rects(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    threshold: u8,
    cell: u32,
) -> Vec<Rect> {
    if width == 0 || height == 0 || cell == 0 || stride < width as usize * 4 {
        return Vec::new();
    }

    let cols = width.div_ceil(cell);
    let rows = height.div_ceil(cell);
    let mut runs: Vec<Vec<(u32, u32)>> = Vec::with_capacity(rows as usize);

    for cy in 0..rows {
        let y0 = cy * cell;
        let y1 = (y0 + cell).min(height);
        let mut row_runs = Vec::new();
        let mut run_start: Option<u32> = None;

        for cx in 0..cols {
            let x0 = cx * cell;
            let x1 = (x0 + cell).min(width);
            let mut opaque = false;

            'scan: for y in y0..y1 {
                let row = y as usize * stride;
                for x in x0..x1 {
                    let alpha = pixels[row + x as usize * 4 + 3];
                    if alpha >= threshold {
                        opaque = true;
                        break 'scan;
                    }
                }
            }

            match (opaque, run_start) {
                (true, None) => run_start = Some(cx),
                (false, Some(start)) => {
                    row_runs.push((start, cx));
                    run_start = None;
                }
                _ => {}
            }
        }
        if let Some(start) = run_start {
            row_runs.push((start, cols));
        }
        runs.push(row_runs);
    }

    // Merge identical horizontal runs across adjacent cell rows.
    #[derive(Clone, Copy)]
    struct OpenRun {
        x0: u32,
        x1: u32,
        y0: u32,
        y1: u32,
    }

    let mut open: Vec<OpenRun> = Vec::new();
    let mut out = Vec::new();

    for (cy, row) in runs.iter().enumerate() {
        let mut next_open = Vec::with_capacity(row.len());
        for &(x0, x1) in row {
            if let Some(index) = open
                .iter()
                .position(|r| r.x0 == x0 && r.x1 == x1 && r.y1 == cy as u32)
            {
                let mut run = open.remove(index);
                run.y1 = cy as u32 + 1;
                next_open.push(run);
            } else {
                next_open.push(OpenRun {
                    x0,
                    x1,
                    y0: cy as u32,
                    y1: cy as u32 + 1,
                });
            }
        }
        for run in open.drain(..) {
            push_rect(
                &mut out, run.x0, run.x1, run.y0, run.y1, cell, width, height,
            );
        }
        open = next_open;
    }
    for run in open {
        push_rect(
            &mut out, run.x0, run.x1, run.y0, run.y1, cell, width, height,
        );
    }

    out
}

fn push_rect(
    out: &mut Vec<Rect>,
    x0: u32,
    x1: u32,
    y0: u32,
    y1: u32,
    cell: u32,
    width: u32,
    height: u32,
) {
    let px = (x0 * cell).min(width) as i32;
    let py = (y0 * cell).min(height) as i32;
    let pw = ((x1 * cell).min(width) as i32 - px).max(0);
    let ph = ((y1 * cell).min(height) as i32 - py).max(0);
    if pw > 0 && ph > 0 {
        out.push(Rect {
            x: px,
            y: py,
            width: pw,
            height: ph,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32, alpha: impl Fn(u32, u32) -> u8) -> Vec<u8> {
        let stride = width as usize * 4;
        let mut pixels = vec![0u8; stride * height as usize];
        for y in 0..height {
            for x in 0..width {
                pixels[y as usize * stride + x as usize * 4 + 3] = alpha(x, y);
            }
        }
        pixels
    }

    #[test]
    fn empty_frame_has_no_rects() {
        let pixels = frame(16, 16, |_, _| 0);
        assert!(alpha_rects(&pixels, 16, 16, 64, 10, 4).is_empty());
    }

    #[test]
    fn fully_opaque_frame_is_one_rect() {
        let pixels = frame(16, 16, |_, _| 255);
        let rects = alpha_rects(&pixels, 16, 16, 64, 10, 4);
        assert_eq!(
            rects,
            vec![Rect {
                x: 0,
                y: 0,
                width: 16,
                height: 16
            }]
        );
    }

    #[test]
    fn separated_shapes_produce_separate_rects() {
        let pixels = frame(16, 16, |x, y| {
            if (x < 4 && y < 4) || (x >= 12 && y >= 12) {
                255
            } else {
                0
            }
        });
        let rects = alpha_rects(&pixels, 16, 16, 64, 10, 4);
        assert!(rects.contains(&Rect {
            x: 0,
            y: 0,
            width: 4,
            height: 4
        }));
        assert!(rects.contains(&Rect {
            x: 12,
            y: 12,
            width: 4,
            height: 4
        }));
    }

    #[test]
    fn threshold_is_respected() {
        let pixels = frame(8, 8, |_, _| 5);
        assert!(alpha_rects(&pixels, 8, 8, 32, 10, 4).is_empty());
    }
}
