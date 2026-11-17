#[derive(Clone, Debug)]
pub struct OutputRect<T> { pub output: T, pub x: i32, pub y: i32, pub width: i32, pub height: i32 }

/// Select by global pointer position, retaining the current output through layout gaps.
pub fn target_output<T>(outputs: &[OutputRect<T>], pointer: (f64, f64)) -> Option<&T> {
    outputs.iter().find(|rect| pointer.0 >= rect.x as f64 && pointer.0 < rect.x as f64 + rect.width as f64
        && pointer.1 >= rect.y as f64 && pointer.1 < rect.y as f64 + rect.height as f64).map(|rect| &rect.output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn chooses_left_right_and_above_outputs_at_boundaries() {
        let outputs = vec![
            OutputRect { output: "main", x: 0, y: 0, width: 1920, height: 1080 },
            OutputRect { output: "left", x: -1280, y: 0, width: 1280, height: 720 },
            OutputRect { output: "right", x: 1920, y: 0, width: 960, height: 540 },
            OutputRect { output: "above", x: 0, y: -1080, width: 1920, height: 1080 },
        ];
        for (point, expected) in [((-1.0, 100.0), Some("left")), ((0.0, 100.0), Some("main")),
            ((1919.9, 100.0), Some("main")), ((1920.0, 100.0), Some("right")),
            ((100.0, -1.0), Some("above")), ((1920.0, -1.0), None)] {
            assert_eq!(target_output(&outputs, point).copied(), expected);
        }
    }
    #[test] fn empty_layout_or_pointer_in_gap_has_no_target() {
        assert!(target_output::<()>(&[], (0.0, 0.0)).is_none());
        let outputs = vec![OutputRect { output: 1, x: 100, y: 100, width: 200, height: 200 }];
        assert!(target_output(&outputs, (0.0, 0.0)).is_none());
    }
}
