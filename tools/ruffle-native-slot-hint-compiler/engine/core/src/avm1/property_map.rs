//! The map of property names to values used by the ActionScript VM.
//! This allows for dynamically choosing case-sensitivity at runtime,
//! because SWFv6 and below is case-insensitive. This also maintains
//! the insertion order of properties, which is necessary for accurate
//! enumeration order.

use crate::string::{AvmString, WStr};
use gc_arena::Collect;
use indexmap::{Equivalent, IndexMap};
use ruffle_common::avm_string::avm1_property_hash;
use std::hash::{BuildHasherDefault, Hash, Hasher};

type PropertyIndexMap<K, V> = IndexMap<K, V, BuildHasherDefault<PropertyHasher>>;

/// The private key wrappers supply the already-computed original FNV hash.
/// Returning it unchanged preserves table buckets and case-collision lookup
/// selection. Hashing this u64 again would not preserve those semantics.
#[derive(Clone, Debug, Default)]
struct PropertyHasher(u64);

impl Hasher for PropertyHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        self.0 = u64::from_ne_bytes(bytes.try_into().expect("property hash must be one u64"));
    }

    #[inline]
    fn write_u64(&mut self, hash: u64) {
        self.0 = hash;
    }
}

/// A map from property names to values.
#[derive(Default, Clone, Debug, Collect)]
#[collect(no_drop)]
pub struct PropertyMap<'gc, V>(PropertyIndexMap<PropertyName<'gc>, V>);

impl<'gc, V> PropertyMap<'gc, V> {
    pub fn new() -> Self {
        Self(PropertyIndexMap::default())
    }

    /// A hint skips only hash-table search, never the current descriptor.
    /// Exact-case keys are unique. A stale index after deletion, a different
    /// object layout or a cloned map is usable only if its current key is equal.
    /// Case-insensitive queries retain IndexMap's original collision selection.
    #[inline]
    fn case_sensitive_index(&self, key: AvmString<'gc>) -> Option<usize> {
        if let Some(index) = key.avm1_property_index_hint()
            && self.0.get_index(index).is_some_and(|(stored, _)| stored.0 == key)
        {
            return Some(index);
        }
        let found = self.0.get_index_of(&CaseSensitive(key));
        if let Some(index) = found {
            key.cache_avm1_property_index(index);
        }
        found
    }

    pub fn contains_key<T: AsRef<WStr>>(&self, key: T, case_sensitive: bool) -> bool {
        if case_sensitive {
            self.0.contains_key(&CaseSensitive(key.as_ref()))
        } else {
            self.0.contains_key(&CaseInsensitive(key.as_ref()))
        }
    }

    /// Retains the managed string identity so repeated queries reuse its hash.
    pub fn contains_key_avm(&self, key: AvmString<'gc>, case_sensitive: bool) -> bool {
        if case_sensitive {
            self.case_sensitive_index(key).is_some()
        } else {
            self.0.contains_key(&CaseInsensitive(key))
        }
    }

    pub fn entry<'a>(&'a mut self, key: AvmString<'gc>, case_sensitive: bool) -> Entry<'gc, 'a, V> {
        if case_sensitive {
            match self.case_sensitive_index(key) {
                Some(index) => Entry::Occupied(OccupiedEntry {
                    map: &mut self.0,
                    index,
                }),
                None => Entry::Vacant(VacantEntry {
                    map: &mut self.0,
                    key,
                }),
            }
        } else {
            match self.0.get_index_of(&CaseInsensitive(key)) {
                Some(index) => Entry::Occupied(OccupiedEntry {
                    map: &mut self.0,
                    index,
                }),
                None => Entry::Vacant(VacantEntry {
                    map: &mut self.0,
                    key,
                }),
            }
        }
    }

    /// Gets the value for the specified property.
    pub fn get<T: AsRef<WStr>>(&self, key: T, case_sensitive: bool) -> Option<&V> {
        if case_sensitive {
            self.0.get(&CaseSensitive(key.as_ref()))
        } else {
            self.0.get(&CaseInsensitive(key.as_ref()))
        }
    }

    pub fn get_avm(&self, key: AvmString<'gc>, case_sensitive: bool) -> Option<&V> {
        if case_sensitive {
            let index = self.case_sensitive_index(key)?;
            self.0.get_index(index).map(|(_, value)| value)
        } else {
            self.0.get(&CaseInsensitive(key))
        }
    }

    /// Gets a mutable reference to the value for the specified property.
    pub fn get_mut<T: AsRef<WStr>>(&mut self, key: T, case_sensitive: bool) -> Option<&mut V> {
        if case_sensitive {
            self.0.get_mut(&CaseSensitive(key.as_ref()))
        } else {
            self.0.get_mut(&CaseInsensitive(key.as_ref()))
        }
    }

    pub fn get_mut_avm(&mut self, key: AvmString<'gc>, case_sensitive: bool) -> Option<&mut V> {
        if case_sensitive {
            let index = self.case_sensitive_index(key)?;
            self.0.get_index_mut(index).map(|(_, value)| value)
        } else {
            self.0.get_mut(&CaseInsensitive(key))
        }
    }

    /// Gets a value by index, based on insertion order.
    pub fn get_index(&self, index: usize) -> Option<&V> {
        self.0.get_index(index).map(|(_, v)| v)
    }

    pub fn insert(&mut self, key: AvmString<'gc>, value: V, case_sensitive: bool) -> Option<V> {
        match self.entry(key, case_sensitive) {
            Entry::Occupied(entry) => Some(entry.insert(value)),
            Entry::Vacant(entry) => {
                entry.insert(value);
                None
            }
        }
    }

    /// Returns the value tuples in Flash's iteration order (most recently added first).
    pub fn iter(&self) -> impl Iterator<Item = (AvmString<'gc>, &V)> {
        self.0.iter().rev().map(|(k, v)| (k.0, v))
    }

    /// Returns the key-value tuples in Flash's iteration order (most recently added first).
    pub fn iter_mut(&mut self) -> impl Iterator<Item = (AvmString<'gc>, &mut V)> {
        self.0.iter_mut().rev().map(|(k, v)| (k.0, v))
    }

    pub fn remove<T: AsRef<WStr>>(&mut self, key: T, case_sensitive: bool) -> Option<V> {
        // Note that we must use shift_remove to maintain order in case this object is enumerated.
        if case_sensitive {
            self.0.shift_remove(&CaseSensitive(key.as_ref()))
        } else {
            self.0.shift_remove(&CaseInsensitive(key.as_ref()))
        }
    }

    pub fn remove_avm(&mut self, key: AvmString<'gc>, case_sensitive: bool) -> Option<V> {
        // Keep shift_remove, including for cached case-insensitive queries.
        if case_sensitive {
            self.0.shift_remove(&CaseSensitive(key))
        } else {
            self.0.shift_remove(&CaseInsensitive(key))
        }
    }
}

pub enum Entry<'gc, 'a, V> {
    Occupied(OccupiedEntry<'gc, 'a, V>),
    Vacant(VacantEntry<'gc, 'a, V>),
}

pub struct OccupiedEntry<'gc, 'a, V> {
    map: &'a mut PropertyIndexMap<PropertyName<'gc>, V>,
    index: usize,
}

impl<'gc, V> OccupiedEntry<'gc, '_, V> {
    pub fn remove_entry(&mut self) -> (AvmString<'gc>, V) {
        let (k, v) = self.map.shift_remove_index(self.index).unwrap();
        (k.0, v)
    }

    pub fn get(&self) -> &V {
        self.map.get_index(self.index).unwrap().1
    }

    pub fn get_mut(&mut self) -> &mut V {
        self.map.get_index_mut(self.index).unwrap().1
    }

    pub fn insert(self, value: V) -> V {
        std::mem::replace(self.map.get_index_mut(self.index).unwrap().1, value)
    }
}

pub struct VacantEntry<'gc, 'a, V> {
    map: &'a mut PropertyIndexMap<PropertyName<'gc>, V>,
    key: AvmString<'gc>,
}

impl<V> VacantEntry<'_, '_, V> {
    pub fn insert(self, value: V) {
        self.map.insert(PropertyName(self.key), value);
    }
}

/// Wraps a str-like type, causing the hash map to use a case insensitive hash and equality.
struct CaseInsensitive<T>(T);

impl Hash for CaseInsensitive<&WStr> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u64(avm1_property_hash(self.0));
    }
}

impl Hash for CaseInsensitive<AvmString<'_>> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u64(self.0.avm1_property_hash());
    }
}

impl<'gc> Equivalent<PropertyName<'gc>> for CaseInsensitive<AvmString<'gc>> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        // Identical immutable ranges are equal under every SWF case rule.
        // Distinct interned names can still differ only in case, so only
        // short-circuit the positive identity case here.
        AvmString::ptr_eq(&key.0, &self.0) || key.0.eq_ignore_case(self.0.as_wstr())
    }
}

impl<'gc> Equivalent<PropertyName<'gc>> for CaseInsensitive<&WStr> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        key.0.eq_ignore_case(self.0)
    }
}

/// Wraps an str-like type, causing the property map to use a case insensitive hash lookup,
/// but case sensitive equality.
struct CaseSensitive<T>(T);

impl Hash for CaseSensitive<&WStr> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u64(avm1_property_hash(self.0));
    }
}

impl Hash for CaseSensitive<AvmString<'_>> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u64(self.0.avm1_property_hash());
    }
}

impl<'gc> Equivalent<PropertyName<'gc>> for CaseSensitive<AvmString<'gc>> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        // Retain managed identity: AvmString's existing equality accepts the
        // same representation, rejects distinct interned names, and otherwise
        // compares the complete immutable WStr contents.
        key.0 == self.0
    }
}

impl<'gc> Equivalent<PropertyName<'gc>> for CaseSensitive<&WStr> {
    fn equivalent(&self, key: &PropertyName<'gc>) -> bool {
        key.0 == self.0
    }
}

/// The property keys stored in the property map.
/// This uses a case insensitive hash to ensure that properties can be found in
/// SWFv6, which is case insensitive. The equality check is handled by the `Equivalent`
/// impls above, which allow it to be either case-sensitive or insensitive.
/// Note that the property of if key1 == key2 -> hash(key1) == hash(key2) still holds.
#[derive(Debug, Clone, PartialEq, Eq, Collect)]
#[collect(no_drop)]
struct PropertyName<'gc>(AvmString<'gc>);

impl Hash for PropertyName<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_u64(self.0.avm1_property_hash());
    }
}

#[cfg(test)]
mod boxhead_hash_tests;

#[cfg(test)]
mod boxhead_equality_tests;

#[cfg(test)]
mod boxhead_slot_hint_tests;
