//! Exact fast paths for homogeneous blocks in the CPU premultiplied-alpha blit.
//!
//! BitmapData's clipping, GPU synchronization, dirty regions and self-copy order
//! remain in operations::copy_on_cpu. This helper only receives disjoint rows
//! after those decisions. It keeps the existing vectorizable loop for mixed
//! blocks and short sprite rows; no texture content is cached between writes.

use crate::bitmap::bitmap_data::Color;

const BLOCK_PIXELS: usize = 32;
const MIN_ROW_PIXELS: usize = BLOCK_PIXELS * 4;
const ALPHA_MASK: u32 = u32::from_ne_bytes([0, 0, 0, 255]);

#[inline]
fn blend_mixed_row(dest: &mut [Color], source: &[Color], opaque: bool) {
    // Keep the opaque check in this loop, as in the pinned implementation:
    // LLVM can if-convert it and vectorize the complete body.
    for (dest, source) in dest.iter_mut().zip(source) {
        let mut color = dest.blend_over(source);
        if opaque {
            color = color.with_alpha(255);
        }
        *dest = color;
    }
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
            let mut any = 0u32;
            for &word in words {
                any |= word;
            }
            if any == 0 {
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
            let mut all_alpha = ALPHA_MASK;
            for &word in words {
                all_alpha &= word;
            }
            if all_alpha == ALPHA_MASK {
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

