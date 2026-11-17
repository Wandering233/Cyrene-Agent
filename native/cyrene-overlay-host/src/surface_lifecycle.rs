/// A new layer surface must receive configure before its first buffer commit.
#[derive(Default)]
pub struct SurfaceLifecycle {
    configured: bool,
}

impl SurfaceLifecycle {
    pub fn replaced(&mut self) {
        self.configured = false;
    }

    pub fn configured(&mut self) {
        self.configured = true;
    }

    pub fn can_attach(&self) -> bool {
        self.configured
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_wait_for_each_surfaces_configure() {
        let mut lifecycle = SurfaceLifecycle::default();
        assert!(!lifecycle.can_attach());
        lifecycle.configured();
        assert!(lifecycle.can_attach());
        lifecycle.replaced();
        assert!(!lifecycle.can_attach());
        lifecycle.configured();
        assert!(lifecycle.can_attach());
        // Unmap/hide has the same handshake requirement as surface replacement.
        lifecycle.replaced();
        assert!(!lifecycle.can_attach());
    }
}
