//! Private Boxhead allocation selection for WebGL bitmap readback.
//!
//! The caller retains the original rectangle, row stride, copy command,
//! submission, capture callback and map/unmap ordering. Only a materially
//! oversized pooled allocation is replaced by a call-local exact allocation.

/// Avoid extra allocation for small padding differences.
pub(super) const MIN_EXCESS_BYTES: u64 = 256 * 1024;

/// A selected exact buffer is call-local and is never returned to the pool.
pub(super) enum BufferChoice<Pooled, Exact> {
    Pooled(Pooled),
    Exact(Exact),
}

/// True only for a nonempty, sufficiently large over-allocation exceeding 2x.
/// Use subtraction rather than multiplying `required`, including near u64::MAX.
pub(super) fn oversized(required: u64, available: u64) -> bool {
    if required == 0 {
        return false;
    }
    let Some(excess) = available.checked_sub(required) else {
        return false;
    };
    excess > required && excess >= MIN_EXCESS_BYTES
}

/// `enabled` is supplied only for the measured WebGL path. The pooled guard is
/// returned before creating the temporary allocation. Other backends and all
/// ineligible sizes retain the same guard without invoking the constructor.
pub(super) fn choose_buffer<Pooled, Exact>(
    enabled: bool,
    required: u64,
    available: u64,
    pooled: Pooled,
    make_exact: impl FnOnce() -> Exact,
) -> BufferChoice<Pooled, Exact> {
    if enabled && oversized(required, available) {
        drop(pooled);
        BufferChoice::Exact(make_exact())
    } else {
        BufferChoice::Pooled(pooled)
    }
}

#[cfg(test)]
mod tests {
    use super::{choose_buffer, oversized, BufferChoice, MIN_EXCESS_BYTES};
    use crate::utils::BufferDimensions;
    use ruffle_render::bitmap::PixelRegion;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    #[test]
    fn boxhead_readback_uses_existing_rgba_row_alignment_at_63_64_65_pixels() {
        for (width, unpadded, padded, size) in [(63, 252, 256, 768), (64, 256, 256, 768), (65, 260, 512, 1536)] {
            let dimensions = BufferDimensions::new(width, 3, wgpu::TextureFormat::Rgba8Unorm);
            assert_eq!(dimensions.width, width);
            assert_eq!(dimensions.height, 3);
            assert_eq!(dimensions.unpadded_bytes_per_row, unpadded);
            assert_eq!(dimensions.padded_bytes_per_row, padded);
            assert_eq!(dimensions.size(), size);
        }
    }

    #[test]
    fn boxhead_readback_clipped_region_dimensions_do_not_include_its_texture_origin() {
        let area = PixelRegion::for_region(7, 11, 17, 19);
        let dimensions = BufferDimensions::new(area.width() as usize, area.height() as usize,
            wgpu::TextureFormat::Rgba8Unorm);
        assert_eq!((area.x_min, area.y_min, area.x_max, area.y_max), (7, 11, 24, 30));
        assert_eq!((dimensions.width, dimensions.height), (17, 19));
        assert_eq!(dimensions.unpadded_bytes_per_row, 68);
        assert_eq!(dimensions.padded_bytes_per_row, 256);
        assert_eq!(dimensions.size(), 4864);
    }

    #[test]
    fn boxhead_readback_ratio_uses_padded_allocation_not_unpadded_pixel_payload() {
        let dimensions = BufferDimensions::new(65, 1024, wgpu::TextureFormat::Rgba8Unorm);
        let required = dimensions.size();
        assert_eq!(required, 512 * 1024);
        assert!(!oversized(required, required + MIN_EXCESS_BYTES));
        assert!(!oversized(required, required * 2));
        assert!(oversized(required, required * 2 + 256));
    }

    struct Guard {
        identity: u64,
        events: Rc<RefCell<Vec<&'static str>>>,
        event: &'static str,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            self.events.borrow_mut().push(self.event);
        }
    }

    #[test]
    fn boxhead_readback_exact_fit_and_small_excess_reuse() {
        for required in [1, 256, 512, 4096, 65536, 1024 * 1024] {
            assert!(!oversized(required, required));
            assert!(!oversized(required, required + 1));
        }
        assert!(!oversized(256, MIN_EXCESS_BYTES + 255));
        assert!(oversized(256, MIN_EXCESS_BYTES + 256));
    }

    #[test]
    fn boxhead_readback_ratio_and_absolute_boundaries_are_both_required() {
        let required = MIN_EXCESS_BYTES;
        assert!(!oversized(required, required * 2));
        assert!(oversized(required, required * 2 + 1));
        assert!(!oversized(1, MIN_EXCESS_BYTES));
        assert!(oversized(1, MIN_EXCESS_BYTES + 1));
    }

    #[test]
    fn boxhead_readback_zero_or_undersized_input_keeps_legacy_path() {
        for available in [0, 1, MIN_EXCESS_BYTES, u64::MAX] {
            assert!(!oversized(0, available));
        }
        for required in [1, MIN_EXCESS_BYTES, u64::MAX] {
            assert!(!oversized(required, required - 1));
        }
    }

    #[test]
    fn boxhead_readback_u64_arithmetic_never_wraps() {
        assert!(!oversized(u64::MAX, u64::MAX));
        assert!(!oversized(u64::MAX / 2 + 1, u64::MAX));
        assert!(oversized(u64::MAX / 2, u64::MAX));
        assert!(oversized(256, u64::MAX));
    }

    #[test]
    fn boxhead_readback_disabled_backend_retains_identical_guard() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let guard = Guard { identity: 73, events: events.clone(), event: "pool-return" };
        let selected = choose_buffer(false, 256, 8 * 1024 * 1024, guard, || -> Guard {
            panic!("An unmeasured backend must never allocate an exact buffer");
        });
        assert!(events.borrow().is_empty());
        match selected {
            BufferChoice::Pooled(guard) => {
                assert_eq!(guard.identity, 73);
                drop(guard);
            }
            BufferChoice::Exact(_) => panic!("Unexpected exact allocation"),
        }
        assert_eq!(&*events.borrow(), &["pool-return"]);
    }

    #[test]
    fn boxhead_readback_eligible_backend_still_reuses_an_exact_fit() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let guard = Guard { identity: 91, events: events.clone(), event: "pool-return" };
        let selected = choose_buffer(true, 4096, 4096, guard, || -> Guard {
            panic!("An exact fit must not invoke a constructor");
        });
        match selected {
            BufferChoice::Pooled(guard) => assert_eq!(guard.identity, 91),
            BufferChoice::Exact(_) => panic!("Unexpected exact allocation"),
        }
        assert_eq!(&*events.borrow(), &["pool-return"]);
    }

    #[test]
    fn boxhead_readback_pool_guard_returns_before_exact_creation() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let guard = Guard { identity: 1, events: events.clone(), event: "pool-return" };
        let selected = choose_buffer(true, 1024, 8 * 1024 * 1024, guard, || {
            assert_eq!(&*events.borrow(), &["pool-return"]);
            events.borrow_mut().push("exact-create");
            Guard { identity: 2, events: events.clone(), event: "exact-drop" }
        });
        match &selected {
            BufferChoice::Exact(guard) => assert_eq!(guard.identity, 2),
            BufferChoice::Pooled(_) => panic!("Oversized buffer was retained for capture"),
        }
        assert_eq!(&*events.borrow(), &["pool-return", "exact-create"]);
        drop(selected);
        assert_eq!(&*events.borrow(), &["pool-return", "exact-create", "exact-drop"]);
    }

    #[test]
    fn boxhead_readback_repeated_exact_calls_retain_no_temporary_allocations() {
        struct Temporary(Rc<Cell<usize>>);
        impl Drop for Temporary {
            fn drop(&mut self) { self.0.set(self.0.get() - 1); }
        }
        let live = Rc::new(Cell::new(0));
        for _ in 0..1000 {
            let selected = choose_buffer(true, 4096, 4 * 1024 * 1024, (), || {
                assert_eq!(live.get(), 0);
                live.set(live.get() + 1);
                Temporary(live.clone())
            });
            assert_eq!(live.get(), 1);
            drop(selected);
            assert_eq!(live.get(), 0);
        }
    }

    #[test]
    fn boxhead_readback_constructor_unwind_has_already_returned_the_pool_guard() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let guard = Guard { identity: 1, events: events.clone(), event: "pool-return" };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            choose_buffer(true, 256, 4 * 1024 * 1024, guard, || -> Guard {
                assert_eq!(&*events.borrow(), &["pool-return"]);
                panic!("Simulated exact allocation failure");
            })
        }));
        assert!(result.is_err());
        assert_eq!(&*events.borrow(), &["pool-return"]);
    }
}
