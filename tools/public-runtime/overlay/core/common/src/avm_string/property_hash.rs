//! AVM1's original property-table hash, shared by managed and borrowed strings.
//!
//! Keep the numeric FNV result unchanged: both case-sensitive and insensitive
//! lookups share one table, including names which differ only in letter case.

use fnv::FnvHasher;
use ruffle_wstr::{Units, WStr, utils};
use std::hash::{Hash, Hasher};

#[inline]
fn hash_unit(unit: u16, state: &mut FnvHasher) {
    // This is the same ASCII branch as the pinned Flash case table. Keeping
    // it here avoids a cross-crate call for each ASCII unit on an uncached key.
    // Latin-1 bytes above 0x7f still use Flash's mapping, not Rust Unicode.
    let folded = if unit < 0x80 {
        u16::from((unit as u8).to_ascii_lowercase())
    } else {
        utils::swf_to_lowercase(unit)
    };
    // Hash the u16 even for byte strings. Hashing a byte here would change
    // the original FNV stream and make equal narrow/wide strings disagree.
    folded.hash(state);
}

/// Computes exactly the original AVM1 property hash for a borrowed string.
///
/// Managed strings expose the same result through a lazy per-range cache.
/// The u16 Hash operations and final u8 delimiter intentionally match the
/// original implementation, including host endianness and lone surrogates.
pub fn avm1_property_hash(value: &WStr) -> u64 {
    let mut state = FnvHasher::default();
    match value.units() {
        Units::Bytes(units) => {
            for &unit in units {
                hash_unit(u16::from(unit), &mut state);
            }
        }
        Units::Wide(units) => {
            for &unit in units {
                hash_unit(unit, &mut state);
            }
        }
    }
    state.write_u8(0xff);
    state.finish()
}
