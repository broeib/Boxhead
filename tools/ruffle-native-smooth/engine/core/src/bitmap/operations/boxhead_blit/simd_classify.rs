//! Read-only classification of one existing 32-pixel blit block.
//!
//! Compiled only for wasm32+simd128. The caller keeps the original first-word
//! guards, row threshold and copy/blend decisions. No pixel content is cached.

use super::{ALPHA_MASK, BLOCK_PIXELS};
use core::arch::wasm32::{
    i32x4_all_true, i32x4_eq, i32x4_splat, v128, v128_and, v128_any_true, v128_load,
    v128_or,
};

// The implementation and pointer arithmetic below require exactly eight
// vectors. A future block-size change must not silently weaken this proof.
const _: () = assert!(BLOCK_PIXELS == 32);

#[inline(always)]
fn load_block(words: &[u32; BLOCK_PIXELS]) -> [v128; 8] {
    let p = words.as_ptr().cast::<v128>();
    // SAFETY: The typed input owns 128 readable bytes. Each load covers one
    // disjoint 16-byte part at offsets 0..112. v128_load requires no alignment;
    // no &[v128] or mutable reference is formed from the 4-byte-aligned input.
    unsafe {
        [
            v128_load(p),
            v128_load(p.add(1)),
            v128_load(p.add(2)),
            v128_load(p.add(3)),
            v128_load(p.add(4)),
            v128_load(p.add(5)),
            v128_load(p.add(6)),
            v128_load(p.add(7)),
        ]
    }
}

#[inline(always)]
pub(super) fn all_zero(words: &[u32]) -> bool {
    let block: &[u32; BLOCK_PIXELS] = match words.try_into() {
        Ok(block) => block,
        Err(_) => {
            // The current chunks_exact caller always supplies 32 words.
            // Keep this safe function exact for any slice, including a future
            // caller: do not read past its end or ignore a longer suffix.
            let mut any = 0u32;
            for &word in words {
                any |= word;
            }
            return any == 0;
        }
    };
    let [a, b, c, d, e, f, g, h] = load_block(block);
    let value = v128_or(
        v128_or(v128_or(a, b), v128_or(c, d)),
        v128_or(v128_or(e, f), v128_or(g, h)),
    );
    !v128_any_true(value)
}

#[inline(always)]
pub(super) fn all_opaque(words: &[u32]) -> bool {
    let block: &[u32; BLOCK_PIXELS] = match words.try_into() {
        Ok(block) => block,
        Err(_) => {
            let mut all_alpha = ALPHA_MASK;
            for &word in words {
                all_alpha &= word;
            }
            return all_alpha == ALPHA_MASK;
        }
    };
    let [a, b, c, d, e, f, g, h] = load_block(block);
    let value = v128_and(
        v128_and(v128_and(a, b), v128_and(c, d)),
        v128_and(v128_and(e, f), v128_and(g, h)),
    );
    // Use the parent's native-endian RGBA mask, identical to its scalar test.
    let mask = i32x4_splat(ALPHA_MASK as i32);
    i32x4_all_true(i32x4_eq(v128_and(value, mask), mask))
}
