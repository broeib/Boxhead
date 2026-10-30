//! Exact two-lane premultiplied-alpha arithmetic for disjoint CPU rows.
//!
//! The enclosing v10 block classifier, clipping, source synchronization,
//! destination dirty handling and self-copy branch are unchanged. This module
//! makes no assumption that raw RGB bytes are bounded by their stored alpha.

use crate::bitmap::bitmap_data::Color;

const BYTE_LANES: u32 = 0x00ff_00ff;
const LANE_ONES: u32 = 0x0001_0001;

/// Both 16-bit input lanes are products of two bytes, hence <=65025.
/// For that entire domain floor(x/255) == (x + 1 + (x >> 8)) >> 8.
/// A lane's largest intermediate is65280, so no carry crosses into its neighbor.
#[inline(always)]
pub(super) fn div255_lanes(products: u32) -> u32 {
    ((products + LANE_ONES + ((products >> 8) & BYTE_LANES)) >> 8) & BYTE_LANES
}

/// All four bytes receive identical scaling, independently of host byte
/// order. The caller supplies the logical source-alpha byte separately.
#[inline(always)]
pub(super) fn scale_word(dest: u32, source_alpha: u8) -> u32 {
    let inverse = 255 - u32::from(source_alpha);
    let even = div255_lanes((dest & BYTE_LANES) * inverse);
    let odd = div255_lanes(((dest >> 8) & BYTE_LANES) * inverse);
    even | (odd << 8)
}

#[inline(always)]
pub(super) fn blend_pixel(dest: Color, source: Color, opaque: bool) -> Color {
    // No unsafe mutable cast or new AnyBitPattern/Pod assertion. Color remains
    // the existing RGBA struct; native-endian conversion is reversible on both
    // endian variants and lets an optimizing compiler combine the byte loads.
    let dest_word = u32::from_ne_bytes([dest.red(), dest.green(), dest.blue(), dest.alpha()]);
    let [red, green, blue, alpha] = scale_word(dest_word, source.alpha()).to_ne_bytes();
    // Preserve the original u8 additions and their order. Invalid raw RGB can
    // overflow even when A=0. These same operators panic or wrap according to
    // the compiler's actual overflow-check setting; no debug_assertions proxy
    // or assumption of premultiplied input is needed.
    let mut output = Color::rgba(
        source.red() + red,
        source.green() + green,
        source.blue() + blue,
        source.alpha() + alpha,
    );
    if opaque {
        output = output.with_alpha(255);
    }
    output
}

#[inline]
pub(super) fn blend_mixed_row(dest: &mut [Color], source: &[Color], opaque: bool) {
    // Same forward zip as the pinned mixed-row loop. The parent already owns
    // the equal-length/disjoint-row contract; no extra allocation is introduced.
    for (dest, source) in dest.iter_mut().zip(source) {
        *dest = blend_pixel(*dest, *source, opaque);
    }
}
