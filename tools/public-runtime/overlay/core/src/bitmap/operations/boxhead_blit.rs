//! Exact fast paths for homogeneous blocks in the CPU premultiplied-alpha blit.
//!
//! BitmapData's clipping, GPU synchronization, dirty regions and self-copy order
//! remain in operations::copy_on_cpu. This helper only receives disjoint rows
//! after those decisions. Mixed blocks and short sprite rows use an exact
//! packed integer kernel; no texture content is cached between writes.

use crate::bitmap::bitmap_data::Color;

mod packed;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod simd_classify;
#[cfg(test)]
mod frozen_v10;
#[cfg(test)]
mod packed_tests;

const BLOCK_PIXELS: usize = 32;
const MIN_ROW_PIXELS: usize = BLOCK_PIXELS * 4;
const ALPHA_MASK: u32 = u32::from_ne_bytes([0, 0, 0, 255]);

#[inline]
fn blend_mixed_row(dest: &mut [Color], source: &[Color], opaque: bool) {
    packed::blend_mixed_row(dest, source, opaque);
}

#[inline]
pub(super) fn blend_row(dest: &mut [Color], source: &[Color], opaque: bool) {
    debug_assert_eq!(dest.len(), source.len());
    if source.len() < MIN_ROW_PIXELS {
        blend_mixed_row(dest, source, opaque);
        return;
    }

    let mut dest_blocks = dest.chunks_exact_mut(BLOCK_PIXELS);
    let mut source_blocks = source.chunks_exact(BLOCK_PIXELS);
    for (dest, source) in dest_blocks.by_ref().zip(source_blocks.by_ref()) {
        // Color is repr(C, align(4)), RGBA bytes, and NoUninit. Read all four
        // bytes: alpha-zero alone is insufficient if raw RGB is nonzero.
        // Native-endian mask construction also keeps the alpha test portable.
        let words: &[u32] = bytemuck::cast_slice(source);
        let first = words[0];
        if first == 0 {
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            let transparent_black = simd_classify::all_zero(words);
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            let transparent_black = {
                let mut any = 0u32;
                for &word in words {
                    any |= word;
                }
                any == 0
            };
            if transparent_black {
                // Transparent black contributes no channel. Opaque destinations
                // must still force A=255, even if their raw pixels had another A.
                if opaque {
                    for pixel in dest {
                        *pixel = pixel.with_alpha(255);
                    }
                }
                continue;
            }
        } else if first & ALPHA_MASK == ALPHA_MASK {
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            let opaque_block = simd_classify::all_opaque(words);
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            let opaque_block = {
                let mut all_alpha = ALPHA_MASK;
                for &word in words {
                    all_alpha &= word;
                }
                all_alpha == ALPHA_MASK
            };
            if opaque_block {
                // A=255 makes the destination multiplier exactly zero for every
                // channel, irrespective of the destination's transparency flag.
                dest.copy_from_slice(source);
                continue;
            }
        }
        // A partial-alpha first pixel rules out both fast paths immediately;
        // mixed cover rows need no complete classification pass in that case.
        blend_mixed_row(dest, source, opaque);
    }
    blend_mixed_row(
        dest_blocks.into_remainder(),
        source_blocks.remainder(),
        opaque,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::UpdateContext;
    use crate::bitmap::bitmap_data::{BitmapData, DirtyState};
    use ruffle_render::bitmap::PixelRegion;

    fn with_bitmap_context(test: impl for<'gc> FnOnce(&mut UpdateContext<'gc>)) {
        let player = crate::player::PlayerBuilder::new()
            .with_movie(crate::tag_utils::SwfMovie::empty(8, None))
            .build();
        let mut player = player.lock().unwrap();
        player.mutate_with_update_context(test);
    }

    // Independent arithmetic oracle, deliberately not Color::blend_over or the
    // block classifier. Inputs to this oracle have sums within u8 range.
    fn reference(dest: Color, source: Color, opaque: bool) -> Color {
        let inverse = 255u16 - u16::from(source.alpha());
        let channel = |a: u8, b: u8| {
            (u16::from(b) + (u16::from(a) * inverse / 255)) as u8
        };
        Color::rgba(
            channel(dest.red(), source.red()),
            channel(dest.green(), source.green()),
            channel(dest.blue(), source.blue()),
            if opaque { 255 } else { channel(dest.alpha(), source.alpha()) },
        )
    }

    fn premultiplied(index: usize, alpha: u8) -> Color {
        let bounded = |factor: usize| ((index * factor) % (usize::from(alpha) + 1)) as u8;
        Color::rgba(bounded(11), bounded(23), bounded(41), alpha)
    }

    #[test]
    fn bitmap_blit_exhaustive_source_destination_alpha_pairs() {
        for dest_alpha in 0..=255u8 {
            for opaque in [false, true] {
                let source: Vec<_> = (0..=255u8)
                    .map(|alpha| premultiplied(usize::from(alpha) + 7, alpha))
                    .collect();
                let mut dest: Vec<_> = (0..source.len())
                    .map(|index| premultiplied(index + 19, dest_alpha))
                    .collect();
                let expected: Vec<_> = dest.iter().zip(&source)
                    .map(|(&dest, &source)| reference(dest, source, opaque))
                    .collect();
                blend_row(&mut dest, &source, opaque);
                assert_eq!(dest, expected, "destination alpha={dest_alpha}, opaque={opaque}");
            }
        }
    }

    #[test]
    fn bitmap_blit_transparent_black_preserves_rgb_and_forces_opaque_alpha() {
        let source = vec![Color::rgba(0, 0, 0, 0); 257];
        let initial: Vec<_> = (0..source.len())
            .map(|index| Color::rgba(index as u8, 99, 201, (index * 7) as u8))
            .collect();
        for opaque in [false, true] {
            let mut dest = initial.clone();
            let expected: Vec<_> = initial.iter()
                .map(|&pixel| reference(pixel, Color::rgba(0, 0, 0, 0), opaque))
                .collect();
            blend_row(&mut dest, &source, opaque);
            assert_eq!(dest, expected);
        }
    }

    #[test]
    fn bitmap_blit_opaque_mixed_blocks_and_every_tail_boundary() {
        for length in [0, 1, 7, 31, 32, 33, 63, 64, 65, 127, 128, 129, 159, 160, 161, 639, 640, 641] {
            let source: Vec<_> = (0..length).map(|index| match index / BLOCK_PIXELS % 3 {
                0 => Color::rgba(0, 0, 0, 0),
                1 => Color::rgba(index as u8, (index * 3) as u8, (index * 7) as u8, 255),
                _ => premultiplied(index, ((index * 13) % 255) as u8),
            }).collect();
            for opaque in [false, true] {
                let mut dest: Vec<_> = (0..length)
                    .map(|index| premultiplied(index + 3, ((index * 17) % 256) as u8))
                    .collect();
                let expected: Vec<_> = dest.iter().zip(&source)
                    .map(|(&dest, &source)| reference(dest, source, opaque))
                    .collect();
                blend_row(&mut dest, &source, opaque);
                assert_eq!(dest, expected, "length={length}, opaque={opaque}");
            }
        }
    }

    #[test]
    fn bitmap_blit_alpha_zero_with_nonzero_rgb_is_not_a_noop() {
        // Public bitmap construction normally premultiplies RGB. The fast path
        // still must not assume that property for every internal raw buffer.
        let mut source = vec![Color::rgba(0, 0, 0, 0); 160];
        for index in [0, 31, 32, 96, 127, 128, 159] {
            source[index] = Color::rgba(7, 11, 13, 0);
        }
        for opaque in [false, true] {
            let mut dest = vec![Color::rgba(17, 19, 23, 31); source.len()];
            let expected: Vec<_> = dest.iter().zip(&source)
                .map(|(&dest, &source)| reference(dest, source, opaque))
                .collect();
            blend_row(&mut dest, &source, opaque);
            assert_eq!(dest, expected);
            assert_eq!(dest[0].red(), 24);
        }
    }

    #[test]
    fn bitmap_blit_real_bitmap_clipped_rows_and_destination_transparency() {
        with_bitmap_context(|context| {
            let source_width = 197usize;
            let source_height = 7usize;
            let dest_width = 211usize;
            let dest_height = 6usize;
            let source_pixels: Vec<_> = (0..source_width * source_height)
                .map(|index| match index / BLOCK_PIXELS % 3 {
                    0 => Color::rgba(0, 0, 0, 0),
                    1 => premultiplied(index, 255),
                    _ => premultiplied(index, ((index * 19) % 255) as u8),
                }).collect();
            let initial: Vec<_> = (0..dest_width * dest_height)
                .map(|index| premultiplied(index, ((index * 17) % 256) as u8))
                .collect();
            for transparent in [false, true] {
                for merge in [false, true] {
                    let source = BitmapData::new_with_pixels(context.gc(),
                        source_width as u32, source_height as u32, true, source_pixels.clone());
                    let dest = BitmapData::new_with_pixels(context.gc(),
                        dest_width as u32, dest_height as u32, transparent, initial.clone());
                    let mut expected = initial.clone();
                    // Requested region extends outside source and destination.
                    // Calculate intersections independently, per pixel.
                    for local_y in 0..8i32 {
                        for local_x in 0..205i32 {
                            let (sx, sy) = (-3 + local_x, 1 + local_y);
                            let (dx, dy) = (5 + local_x, -1 + local_y);
                            if sx < 0 || sy < 0 || dx < 0 || dy < 0
                                || sx >= source_width as i32 || sy >= source_height as i32
                                || dx >= dest_width as i32 || dy >= dest_height as i32 {
                                continue;
                            }
                            let source = source_pixels[sx as usize + sy as usize * source_width];
                            let slot = dx as usize + dy as usize * dest_width;
                            expected[slot] = if merge || !transparent {
                                reference(expected[slot], source, !transparent)
                            } else { source };
                        }
                    }
                    crate::bitmap::operations::copy_pixels(context, dest, source,
                        (-3, 1, 205, 8), (5, -1), merge);
                    let read = dest.read_area(
                        PixelRegion::for_whole_size(dest_width as u32, dest_height as u32),
                        context.renderer,
                    );
                    assert_eq!(read.raw_pixels(), expected.as_slice(), "transparent={transparent}, merge={merge}");
                    assert!(matches!(read.dirty_state(), DirtyState::CpuModified(_)));
                }
            }
        });
    }

    #[test]
    fn bitmap_blit_real_bitmap_self_overlap_keeps_original_forward_order() {
        with_bitmap_context(|context| {
            let (width, height) = (161usize, 5usize);
            let initial: Vec<_> = (0..width * height)
                .map(|index| premultiplied(index, ((index * 11) % 256) as u8))
                .collect();
            for merge in [false, true] {
                let bitmap = BitmapData::new_with_pixels(context.gc(),
                    width as u32, height as u32, true, initial.clone());
                let mut expected = initial.clone();
                // Deliberately read the evolving destination just as the
                // pinned self-copy branch does, including overlapping rows.
                for y in 0..4usize {
                    for x in 0..149usize {
                        let source = expected[x + y * width];
                        let slot = x + 7 + (y + 1) * width;
                        expected[slot] = if merge {
                            reference(expected[slot], source, false)
                        } else { source };
                    }
                }
                crate::bitmap::operations::copy_pixels(context, bitmap, bitmap,
                    (0, 0, 149, 4), (7, 1), merge);
                let read = bitmap.read_area(
                    PixelRegion::for_whole_size(width as u32, height as u32),
                    context.renderer,
                );
                assert_eq!(read.raw_pixels(), expected.as_slice(), "merge={merge}");
            }
        });
    }

    #[test]
    #[ignore = "CI-only release-mode diagnostic; not an FPS acceptance test"]
    fn bitmap_blit_row_microbenchmark() {
        use std::hint::black_box;
        use std::time::Instant;

        #[inline(never)]
        fn baseline(dest: &mut [Color], source: &[Color], opaque: bool) {
            super::frozen_v10::blend_row(dest, source, opaque);
        }

        #[inline(never)]
        fn optimized(dest: &mut [Color], source: &[Color], opaque: bool) {
            blend_row(dest, source, opaque);
        }

        let iterations = 20_000usize;
        for (name, length, mode) in [
            ("sparse-cover", 640usize, 0usize),
            ("opaque-cover", 640, 1),
            ("mixed-cover", 640, 2),
            ("mixed-sprite", 64, 2),
            ("binary-sprite", 32, 3),
            ("short-mixed-tail", 65, 2),
        ] {
            let source: Vec<_> = (0..length).map(|index| match mode {
                0 if index % 160 >= 8 => Color::rgba(0, 0, 0, 0),
                1 => premultiplied(index, 255),
                3 => if index % 7 < 3 { Color::rgba(0, 0, 0, 0) } else { premultiplied(index, 255) },
                _ => premultiplied(index, (index % 254 + 1) as u8),
            }).collect();
            for opaque in [false, true] {
                for round in 0..3 {
                    let mut elapsed = [0u128; 2];
                    let mut result = [Vec::new(), Vec::new()];
                    for candidate in [round % 2, (round + 1) % 2] {
                        let mut dest = vec![Color::rgba(16, 32, 64, 255); length];
                        let start = Instant::now();
                        for _ in 0..iterations {
                            if candidate == 0 {
                                baseline(black_box(&mut dest), black_box(&source), opaque);
                            } else {
                                optimized(black_box(&mut dest), black_box(&source), opaque);
                            }
                        }
                        elapsed[candidate] = start.elapsed().as_micros();
                        result[candidate] = dest;
                    }
                    assert_eq!(result[0], result[1]);
                    println!("{{\"case\":\"{name}\",\"opaque\":{opaque},\"round\":{round},\"iterations\":{iterations},\"pixelsPerRow\":{length},\"baselineUs\":{},\"candidateUs\":{}}}", elapsed[0], elapsed[1]);
                }
            }
        }
    }
}
