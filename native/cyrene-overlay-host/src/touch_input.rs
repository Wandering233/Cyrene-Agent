use crate::protocol::PointerEventName;
use std::collections::HashSet;

#[derive(Debug, PartialEq)]
pub struct TouchEvent {
    pub event: PointerEventName,
    pub position: (f64, f64),
}

#[derive(Default)]
pub struct TouchInput {
    contacts: HashSet<i32>,
    primary: Option<(i32, (f64, f64))>,
}

impl TouchInput {
    pub fn down(&mut self, id: i32, position: (f64, f64)) -> Option<TouchEvent> {
        let first = self.contacts.is_empty();
        if !self.contacts.insert(id) || !first {
            return None;
        }
        self.primary = Some((id, position));
        Some(TouchEvent {
            event: PointerEventName::Down,
            position,
        })
    }

    pub fn motion(&mut self, id: i32, position: (f64, f64)) -> Option<TouchEvent> {
        let (primary, last) = self.primary.as_mut()?;
        if *primary != id {
            return None;
        }
        *last = position;
        Some(TouchEvent {
            event: PointerEventName::Motion,
            position,
        })
    }

    pub fn up(&mut self, id: i32) -> Option<TouchEvent> {
        self.contacts.remove(&id);
        if self.primary.as_ref()?.0 != id {
            return None;
        }
        let (_, position) = self.primary.take()?;
        Some(TouchEvent {
            event: PointerEventName::Up,
            position,
        })
    }

    pub fn cancel(&mut self) -> Option<TouchEvent> {
        self.contacts.clear();
        let (_, position) = self.primary.take()?;
        Some(TouchEvent {
            event: PointerEventName::Cancel,
            position,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secondary_contacts_never_release_or_move_the_primary_mouse_button() {
        let mut input = TouchInput::default();
        assert!(input.down(3, (10.0, 20.0)).is_some());
        assert!(input.down(8, (50.0, 60.0)).is_none());
        assert!(input.motion(8, (80.0, 90.0)).is_none());
        assert!(input.up(8).is_none());
        input.motion(3, (12.0, 24.0));
        assert_eq!(
            input.up(3),
            Some(TouchEvent {
                event: PointerEventName::Up,
                position: (12.0, 24.0)
            })
        );
        assert!(input.up(3).is_none());
    }

    #[test]
    fn no_secondary_promotion_until_the_whole_gesture_ends() {
        let mut input = TouchInput::default();
        input.down(3, (10.0, 20.0));
        input.down(8, (30.0, 40.0));
        input.up(3);
        assert!(input.motion(8, (50.0, 60.0)).is_none());
        assert!(input.down(9, (50.0, 60.0)).is_none());
        input.up(8);
        input.up(9);
        assert!(input.down(8, (70.0, 80.0)).is_some());
    }

    #[test]
    fn cancel_and_surface_or_device_removal_release_once_and_allow_a_new_gesture() {
        let mut input = TouchInput::default();
        input.down(2, (10.0, 20.0));
        input.down(9, (40.0, 50.0));
        assert_eq!(
            input.cancel(),
            Some(TouchEvent {
                event: PointerEventName::Cancel,
                position: (10.0, 20.0)
            })
        );
        assert!(input.cancel().is_none());
        assert!(input.up(2).is_none());
        assert!(input.motion(9, (1.0, 2.0)).is_none());
        assert!(input.down(2, (10.0, 20.0)).is_some());
    }
}
