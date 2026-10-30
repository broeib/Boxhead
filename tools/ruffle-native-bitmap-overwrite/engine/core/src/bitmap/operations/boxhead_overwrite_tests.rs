//! Actual BitmapData dirty-state fixtures with a scripted GPU readback backend.
//! They test synchronization ownership and frozen pixel semantics, not GPU time.

use super::*;
use crate::bitmap::bitmap_data::DirtyState;
use ruffle_render::backend::{
    null::NullRenderer, BitmapCacheEntry, Context3D, Context3DProfile, PixelBenderOutput,
    PixelBenderTarget, ShapeHandle, ViewportDimensions,
};
use ruffle_render::bitmap::{Bitmap, BitmapHandle, BitmapSource, RgbaBufRead, SyncHandle};
use ruffle_render::error::Error as RenderError;
use ruffle_render::pixel_bender::{PixelBenderShader, PixelBenderShaderHandle};
use ruffle_render::pixel_bender_support::PixelBenderShaderArgument;
use ruffle_render::shape_utils::DistilledShape;
use std::any::Any;
use std::borrow::Cow;
use std::cell::RefCell;
use std::num::NonZeroU32;
use std::rc::Rc;

#[path = "boxhead_overwrite_frozen.rs"]
mod frozen;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Event {
    Resolved(&'static str),
    Dropped(&'static str),
    Uploaded(PixelRegion, Vec<u8>),
}

type Trace = Rc<RefCell<Vec<Event>>>;

#[derive(Debug)]
struct ScriptedSync {
    label: &'static str,
    bytes: Vec<u8>,
    stride: u32,
    trace: Trace,
}

impl SyncHandle for ScriptedSync {}

impl Drop for ScriptedSync {
    fn drop(&mut self) {
        self.trace.borrow_mut().push(Event::Dropped(self.label));
    }
}

struct ScriptedRenderer {
    inner: NullRenderer,
    trace: Trace,
}

impl RenderBackend for ScriptedRenderer {
    fn viewport_dimensions(&self) -> ViewportDimensions { self.inner.viewport_dimensions() }
    fn set_viewport_dimensions(&mut self, value: ViewportDimensions) { self.inner.set_viewport_dimensions(value); }
    fn register_shape(&mut self, shape: DistilledShape, source: &dyn BitmapSource) -> ShapeHandle {
        self.inner.register_shape(shape, source)
    }
    fn render_offscreen(&mut self, handle: BitmapHandle, commands: CommandList,
        quality: StageQuality, bounds: PixelRegion) -> Option<Box<dyn SyncHandle>> {
        self.inner.render_offscreen(handle, commands, quality, bounds)
    }
    fn submit_frame(&mut self, clear: swf::Color, commands: CommandList, entries: Vec<BitmapCacheEntry>) {
        self.inner.submit_frame(clear, commands, entries);
    }
    fn create_empty_texture(&mut self, width: NonZeroU32, height: NonZeroU32) -> Result<BitmapHandle, RenderError> {
        self.inner.create_empty_texture(width, height)
    }
    fn register_bitmap(&mut self, bitmap: Bitmap<'_>) -> Result<BitmapHandle, RenderError> {
        self.inner.register_bitmap(bitmap)
    }
    fn update_texture(&mut self, handle: &BitmapHandle, bitmap: Bitmap<'_>, region: PixelRegion) -> Result<(), RenderError> {
        self.trace.borrow_mut().push(Event::Uploaded(region, bitmap.data().to_vec()));
        self.inner.update_texture(handle, bitmap, region)
    }
    fn create_context3d(&mut self, profile: Context3DProfile) -> Result<Box<dyn Context3D>, RenderError> {
        self.inner.create_context3d(profile)
    }
    fn debug_info(&self) -> Cow<'static, str> { Cow::Borrowed("Scripted bitmap overwrite fixture") }
    fn name(&self) -> &'static str { "boxhead-bitmap-overwrite-fixture" }
    fn set_quality(&mut self, quality: StageQuality) { self.inner.set_quality(quality); }
    fn compile_pixelbender_shader(&mut self, shader: PixelBenderShader) -> Result<PixelBenderShaderHandle, RenderError> {
        self.inner.compile_pixelbender_shader(shader)
    }
    fn run_pixelbender_shader(&mut self, handle: PixelBenderShaderHandle,
        arguments: &[PixelBenderShaderArgument], target: &PixelBenderTarget) -> Result<PixelBenderOutput, RenderError> {
        self.inner.run_pixelbender_shader(handle, arguments, target)
    }
    fn resolve_sync_handle(&mut self, handle: Box<dyn SyncHandle>, with_rgba: RgbaBufRead) -> Result<(), RenderError> {
        let scripted = (handle.as_ref() as &dyn Any).downcast_ref::<ScriptedSync>()
            .expect("unexpected fixture sync handle");
        self.trace.borrow_mut().push(Event::Resolved(scripted.label));
        with_rgba(&scripted.bytes, scripted.stride);
        Ok(())
    }
}

fn with_context(test: impl for<'gc> FnOnce(&mut UpdateContext<'gc>, &Trace)) {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let player = crate::player::PlayerBuilder::new()
        .with_movie(crate::tag_utils::SwfMovie::empty(8, None))
        .with_renderer(ScriptedRenderer {
            inner: NullRenderer::new(ViewportDimensions { width: 32, height: 32, scale_factor: 1.0 }),
            trace: trace.clone(),
        }).build();
    player.lock().unwrap().mutate_with_update_context(|context| test(context, &trace));
}

fn pixels(width: u32, height: u32, seed: u32, opaque: bool) -> Vec<Color> {
    (0..width * height).map(|index| {
        let alpha = if opaque { 255 } else { ((index * 37 + seed * 11) % 256) as u8 };
        let limit = u32::from(alpha) + 1;
        Color::rgba(((index * 7 + seed) % limit) as u8,
            ((index * 13 + seed * 3) % limit) as u8,
            ((index * 23 + seed * 5) % limit) as u8, alpha)
    }).collect()
}

fn bitmap<'gc>(context: &UpdateContext<'gc>, width: u32, height: u32,
    transparent: bool, pixels: Vec<Color>) -> BitmapData<'gc> {
    BitmapData::new_with_pixels(context.gc(), width, height, transparent, pixels)
}

fn dirty_gpu<'gc>(context: &mut UpdateContext<'gc>, bitmap: BitmapData<'gc>,
    label: &'static str, fresh: &[Color], region: PixelRegion, trace: &Trace) {
    // Readback rows deliberately have padding, and a dirty subregion need not
    // start at zero. This exercises real copy_pixels_to_bitmapdata indexing.
    let stride = (region.width() + 2) * 4;
    let mut bytes = vec![0xa5; (stride * region.height()) as usize];
    for y in region.y_min..region.y_max {
        for x in region.x_min..region.x_max {
            let color = fresh[(y * bitmap.width() + x) as usize];
            let offset = ((y - region.y_min) * stride + (x - region.x_min) * 4) as usize;
            bytes[offset..offset + 4].copy_from_slice(&[color.red(), color.green(), color.blue(), color.alpha()]);
        }
    }
    bitmap.sync(context.renderer).borrow_mut(context.gc()).set_gpu_dirty(context.gc(),
        Box::new(ScriptedSync { label, bytes, stride, trace: trace.clone() }), region);
}

fn run_copy<'gc>(context: &mut UpdateContext<'gc>, source: BitmapData<'gc>, dest: BitmapData<'gc>,
    source_region: PixelRegion, dest_region: PixelRegion, blend: bool, oracle: bool) {
    if oracle {
        frozen::copy_on_cpu(context.gc(), context.renderer, source, dest, source_region, dest_region, blend);
    } else {
        super::copy_on_cpu(context.gc(), context.renderer, source, dest, source_region, dest_region, blend);
    }
}

fn snapshot(context: &mut UpdateContext<'_>, bitmap: BitmapData<'_>) -> (Vec<Color>, Option<PixelRegion>) {
    let full = PixelRegion::for_whole_size(bitmap.width(), bitmap.height());
    let read = bitmap.read_area(full, context.renderer);
    let dirty = match read.dirty_state() {
        DirtyState::CpuModified(region) => Some(*region),
        DirtyState::Clean => None,
        DirtyState::GpuModified(_, _) => panic!("read_area failed to resolve actual GPU pixels"),
    };
    (read.raw_pixels().to_vec(), dirty)
}

fn resolved(trace: &Trace, label: &'static str) -> usize {
    trace.borrow().iter().filter(|event| **event == Event::Resolved(label)).count()
}

fn dropped(trace: &Trace, label: &'static str) -> usize {
    trace.borrow().iter().filter(|event| **event == Event::Dropped(label)).count()
}

#[test]
fn bitmap_overwrite_full_nonblend_matches_frozen_pixels_for_all_transparency_pairs() {
    with_context(|context, trace| {
        let (width, height) = (161, 3);
        let full = PixelRegion::for_whole_size(width, height);
        for source_transparent in [false, true] {
            for dest_transparent in [false, true] {
                let mut output = Vec::new();
                for oracle in [false, true] {
                    trace.borrow_mut().clear();
                    let source_pixels = pixels(width, height, 5, !source_transparent);
                    let source = bitmap(context, width, height, source_transparent, source_pixels);
                    let dest = bitmap(context, width, height, dest_transparent, pixels(width, height, 1, !dest_transparent));
                    dirty_gpu(context, dest, "dest", &pixels(width, height, 9, !dest_transparent), full, trace);
                    run_copy(context, source, dest, full, full, false, oracle);
                    assert_eq!(resolved(trace, "dest"), usize::from(oracle));
                    assert_eq!(dropped(trace, "dest"), 1);
                    let actual = snapshot(context, dest);
                    assert_eq!(actual.1, Some(full));
                    output.push(actual);
                }
                assert_eq!(output[0], output[1], "source={source_transparent}, dest={dest_transparent}");
            }
        }
    });
}

#[test]
fn bitmap_overwrite_opaque_source_normalizes_requested_blend_before_guard() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(7, 5);
        for transparent in [false, true] {
            let source_pixels = pixels(7, 5, 6, true);
            let source = bitmap(context, 7, 5, false, source_pixels.clone());
            let dest = bitmap(context, 7, 5, transparent, pixels(7, 5, 1, !transparent));
            trace.borrow_mut().clear();
            dirty_gpu(context, dest, "dest", &pixels(7, 5, 2, !transparent), full, trace);
            run_copy(context, source, dest, full, full, true, false);
            assert_eq!(resolved(trace, "dest"), 0);
            assert_eq!(dropped(trace, "dest"), 1);
            assert_eq!(snapshot(context, dest), (source_pixels, Some(full)));
        }
    });
}

#[test]
fn bitmap_overwrite_transparent_to_opaque_unmultiplied_branch_keeps_raw_alpha_edges() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(6, 1);
        let source_pixels = vec![Color::rgba(7, 11, 13, 0), Color::rgba(0, 0, 0, 0),
            Color::rgba(1, 1, 1, 1), Color::rgba(12, 31, 64, 127),
            Color::rgba(200, 100, 25, 254), Color::rgba(9, 19, 29, 255)];
        let mut output = Vec::new();
        for oracle in [false, true] {
            trace.borrow_mut().clear();
            let source = bitmap(context, 6, 1, true, source_pixels.clone());
            let dest = bitmap(context, 6, 1, false, pixels(6, 1, 3, true));
            dirty_gpu(context, dest, "dest", &pixels(6, 1, 7, true), full, trace);
            run_copy(context, source, dest, full, full, false, oracle);
            assert_eq!(resolved(trace, "dest"), usize::from(oracle));
            output.push(snapshot(context, dest));
        }
        assert_eq!(output[0], output[1]);
        assert!(output[0].0.iter().all(|color| color.alpha() == 255));
    });
}

#[test]
fn bitmap_overwrite_cancels_only_destination_and_reads_fresh_dirty_source() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(9, 4);
        let fresh = pixels(9, 4, 23, false);
        let mut output = Vec::new();
        for oracle in [false, true] {
            trace.borrow_mut().clear();
            let source = bitmap(context, 9, 4, true, pixels(9, 4, 1, false));
            let dest = bitmap(context, 9, 4, true, pixels(9, 4, 2, false));
            dirty_gpu(context, source, "source", &fresh, full, trace);
            dirty_gpu(context, dest, "dest", &pixels(9, 4, 3, false), full, trace);
            run_copy(context, source, dest, full, full, false, oracle);
            assert_eq!(resolved(trace, "source"), 1);
            assert_eq!(resolved(trace, "dest"), usize::from(oracle));
            assert_eq!(dropped(trace, "source"), 1); assert_eq!(dropped(trace, "dest"), 1);
            output.push(snapshot(context, dest));
        }
        assert_eq!(output[0], output[1]); assert_eq!(output[0].0, fresh);
    });
}

#[test]
fn bitmap_overwrite_source_read_area_does_not_resolve_unrelated_gpu_dirty_pixels() {
    with_context(|context, trace| {
        let region = PixelRegion::for_whole_size(4, 4);
        let dirty = PixelRegion::for_region(6, 6, 2, 2);
        let source_pixels = pixels(8, 8, 5, false);
        let source = bitmap(context, 8, 8, true, source_pixels.clone());
        let dest = bitmap(context, 4, 4, true, pixels(4, 4, 2, false));
        dirty_gpu(context, source, "source", &pixels(8, 8, 17, false), dirty, trace);
        dirty_gpu(context, dest, "dest", &pixels(4, 4, 3, false), region, trace);
        run_copy(context, source, dest, region, region, false, false);
        assert_eq!(resolved(trace, "source"), 0); assert_eq!(dropped(trace, "source"), 0);
        assert_eq!(resolved(trace, "dest"), 0); assert_eq!(dropped(trace, "dest"), 1);
        assert!(source.can_read(region)); assert!(!source.can_read(dirty));
        let expected: Vec<_> = (0..4).flat_map(|y| source_pixels[y * 8..y * 8 + 4].iter().copied()).collect();
        assert_eq!(snapshot(context, dest).0, expected);
        snapshot(context, source);
        assert_eq!(resolved(trace, "source"), 1);
    });
}

#[test]
fn bitmap_overwrite_full_destination_cancels_partial_gpu_dirty_region_with_padded_rows() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(8, 5);
        let dirty = PixelRegion::for_region(2, 1, 4, 3);
        let mut output = Vec::new();
        for oracle in [false, true] {
            trace.borrow_mut().clear();
            let source = bitmap(context, 8, 5, true, pixels(8, 5, 7, false));
            let dest = bitmap(context, 8, 5, true, pixels(8, 5, 1, false));
            dirty_gpu(context, dest, "dest", &pixels(8, 5, 4, false), dirty, trace);
            run_copy(context, source, dest, full, full, false, oracle);
            assert_eq!(resolved(trace, "dest"), usize::from(oracle));
            assert_eq!(dropped(trace, "dest"), 1);
            output.push(snapshot(context, dest));
        }
        assert_eq!(output[0], output[1]); assert_eq!(output[0].1, Some(full));
    });
}

#[test]
fn bitmap_overwrite_partial_and_source_clipped_destinations_keep_original_gpu_pixels() {
    with_context(|context, trace| {
        let dest_full = PixelRegion::for_whole_size(6, 5);
        let mut output = Vec::new();
        for oracle in [false, true] {
            trace.borrow_mut().clear();
            let source = bitmap(context, 4, 3, true, pixels(4, 3, 4, false));
            let dest = bitmap(context, 6, 5, true, pixels(6, 5, 1, false));
            let gpu_pixels = pixels(6, 5, 9, false);
            dirty_gpu(context, dest, "dest", &gpu_pixels, dest_full, trace);
            if oracle {
                frozen::copy_on_cpu(context.gc(), context.renderer, source, dest,
                    PixelRegion::for_whole_size(4, 3), PixelRegion::for_region(1, 1, 4, 3), false);
            } else {
                // The requested size exceeds source bounds. The clipped
                // destination is partial even though the request covers it.
                super::copy_pixels(context, dest, source, (0, 0, 8, 8), (1, 1), false);
            }
            assert_eq!(resolved(trace, "dest"), 1);
            let actual = snapshot(context, dest);
            assert_eq!(actual.0[0], gpu_pixels[0]);
            assert_eq!(actual.0[29], gpu_pixels[29]);
            output.push(actual);
        }
        assert_eq!(output[0], output[1]);
    });
}

#[test]
fn bitmap_overwrite_clipping_can_still_cover_the_whole_destination_from_an_offset_source() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(4, 3);
        let mut output = Vec::new();
        for oracle in [false, true] {
            trace.borrow_mut().clear();
            let source = bitmap(context, 8, 7, true, pixels(8, 7, 5, false));
            let dest = bitmap(context, 4, 3, true, pixels(4, 3, 1, false));
            dirty_gpu(context, dest, "dest", &pixels(4, 3, 11, false), full, trace);
            if oracle {
                frozen::copy_on_cpu(context.gc(), context.renderer, source, dest,
                    PixelRegion::for_region(3, 3, 4, 3), full, false);
            } else {
                super::copy_pixels(context, dest, source, (1, 2, 8, 6), (-2, -1), false);
            }
            assert_eq!(resolved(trace, "dest"), usize::from(oracle));
            output.push(snapshot(context, dest));
        }
        assert_eq!(output[0], output[1]);
    });
}

#[test]
fn bitmap_overwrite_full_transparent_blend_still_reads_destination() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(160, 3);
        for transparent in [false, true] {
            let mut output = Vec::new();
            for oracle in [false, true] {
                trace.borrow_mut().clear();
                let source = bitmap(context, 160, 3, true, pixels(160, 3, 7, false));
                let dest = bitmap(context, 160, 3, transparent, pixels(160, 3, 1, !transparent));
                dirty_gpu(context, dest, "dest", &pixels(160, 3, 13, !transparent), full, trace);
                run_copy(context, source, dest, full, full, true, oracle);
                assert_eq!(resolved(trace, "dest"), 1);
                output.push(snapshot(context, dest));
            }
            assert_eq!(output[0], output[1]);
        }
    });
}

#[test]
fn bitmap_overwrite_self_noop_and_overlap_keep_frozen_sync_and_forward_order() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(7, 4);
        for (source_region, dest_region, blend) in [
            (full, full, false),
            (full, full, true),
            (PixelRegion::for_region(0, 0, 5, 3), PixelRegion::for_region(1, 1, 5, 3), false),
            (PixelRegion::for_region(0, 0, 5, 3), PixelRegion::for_region(1, 1, 5, 3), true),
        ] {
            let mut output = Vec::new();
            for oracle in [false, true] {
                trace.borrow_mut().clear();
                let dest = bitmap(context, 7, 4, true, pixels(7, 4, 1, false));
                dirty_gpu(context, dest, "self", &pixels(7, 4, 9, false), full, trace);
                run_copy(context, dest, dest, source_region, dest_region, blend, oracle);
                if !blend && source_region == dest_region {
                    assert_eq!(resolved(trace, "self"), 0); assert_eq!(dropped(trace, "self"), 0);
                    assert!(!dest.can_read(full));
                } else {
                    assert_eq!(resolved(trace, "self"), 1); assert_eq!(dropped(trace, "self"), 1);
                }
                output.push(snapshot(context, dest));
            }
            assert_eq!(output[0], output[1]);
        }
    });
}

#[test]
fn bitmap_overwrite_clean_and_cpu_dirty_targets_keep_upload_bytes_and_dirty_union() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(8, 4);
        for cpu_dirty in [false, true] {
            let mut outputs = Vec::new();
            for oracle in [false, true] {
                trace.borrow_mut().clear();
                let source = bitmap(context, 8, 4, true, pixels(8, 4, 11, false));
                let dest = bitmap(context, 8, 4, true, pixels(8, 4, 3, false));
                dest.bitmap_handle(context.gc(), context.renderer);
                if cpu_dirty {
                    dest.sync(context.renderer).borrow_mut(context.gc())
                        .set_cpu_dirty(context.gc(), PixelRegion::for_region(2, 1, 3, 2));
                }
                run_copy(context, source, dest, full, full, false, oracle);
                let output = snapshot(context, dest);
                assert_eq!(output.1, Some(full));
                dest.bitmap_handle(context.gc(), context.renderer);
                let expected: Vec<_> = output.0.iter().flat_map(|color|
                    [color.red(), color.green(), color.blue(), color.alpha()]).collect();
                assert_eq!(&*trace.borrow(), &[Event::Uploaded(full, expected)]);
                assert_eq!(snapshot(context, dest).1, None);
                outputs.push(output);
            }
            assert_eq!(outputs[0], outputs[1]);
        }
    });
}

#[test]
fn bitmap_overwrite_empty_public_copy_does_not_cancel_or_resolve_any_handle() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(4, 3);
        for rect in [(0, 0, 0, 3), (0, 0, 4, 0), (99, 99, 4, 3)] {
            trace.borrow_mut().clear();
            let source = bitmap(context, 4, 3, true, pixels(4, 3, 1, false));
            let dest = bitmap(context, 4, 3, true, pixels(4, 3, 2, false));
            dirty_gpu(context, source, "source", &pixels(4, 3, 3, false), full, trace);
            dirty_gpu(context, dest, "dest", &pixels(4, 3, 4, false), full, trace);
            super::copy_pixels(context, dest, source, rect, (0, 0), false);
            assert!(trace.borrow().is_empty());
            assert!(!source.can_read(full)); assert!(!dest.can_read(full));
            snapshot(context, source); snapshot(context, dest);
        }
    });
}

#[test]
fn bitmap_overwrite_separate_alpha_mask_retains_original_three_handle_reads() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(5, 3);
        let source = bitmap(context, 5, 3, true, pixels(5, 3, 1, false));
        let alpha = bitmap(context, 5, 3, true, pixels(5, 3, 2, false));
        let dest = bitmap(context, 5, 3, true, pixels(5, 3, 3, false));
        dirty_gpu(context, source, "source", &pixels(5, 3, 7, true), full, trace);
        dirty_gpu(context, alpha, "alpha", &vec![Color::rgba(0, 0, 0, 0); 15], full, trace);
        dirty_gpu(context, dest, "dest", &pixels(5, 3, 9, false), full, trace);
        super::copy_pixels_with_alpha_source(context, dest, source, (0, 0, 5, 3), (0, 0), alpha, (0, 0), false);
        let reads: Vec<_> = trace.borrow().iter().filter_map(|event|
            if let Event::Resolved(label) = event { Some(*label) } else { None }).collect();
        assert_eq!(reads, ["source", "alpha", "dest"]);
        assert_eq!(snapshot(context, dest), (vec![Color::rgba(0, 0, 0, 0); 15], Some(full)));
    });
}

#[test]
fn bitmap_overwrite_unsupported_filter_copy_uses_the_same_frozen_full_overwrite() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(7, 5);
        for transparent in [false, true] {
            let mut output = Vec::new();
            for oracle in [false, true] {
                trace.borrow_mut().clear();
                let source = bitmap(context, 7, 5, true, pixels(7, 5, 7, false));
                let dest = bitmap(context, 7, 5, transparent, pixels(7, 5, 1, !transparent));
                dirty_gpu(context, dest, "dest", &pixels(7, 5, 3, !transparent), full, trace);
                if oracle {
                    frozen::copy_on_cpu(context.gc(), context.renderer, source, dest, full, full, false);
                } else {
                    super::apply_filter(context, dest, source, (0, 0), (7, 5), (0, 0), Filter::default());
                }
                assert_eq!(resolved(trace, "dest"), usize::from(oracle));
                output.push(snapshot(context, dest));
            }
            assert_eq!(output[0], output[1]);
        }
    });
}

#[test]
fn bitmap_overwrite_existing_cpu_draw_caller_keeps_opaque_pixels_and_no_readback() {
    with_context(|context, trace| {
        let full = PixelRegion::for_whole_size(8, 4);
        for blend in [BlendMode::Normal, BlendMode::Layer] {
            trace.borrow_mut().clear();
            let expected = pixels(8, 4, 11, true);
            let source = bitmap(context, 8, 4, false, expected.clone());
            let dest = bitmap(context, 8, 4, true, pixels(8, 4, 1, false));
            super::draw(context, dest, IBitmapDrawable::BitmapData(source), Transform::default(),
                false, blend, None, StageQuality::High).unwrap();
            assert_eq!(snapshot(context, dest), (expected, Some(full)));
            assert!(trace.borrow().is_empty());
        }
    });
}
