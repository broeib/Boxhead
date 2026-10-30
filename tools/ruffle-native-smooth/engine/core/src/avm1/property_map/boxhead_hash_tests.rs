//! Exact-hash and real AVM1 semantic fixtures for the immutable string cache.
//! The oracle below intentionally retains the pinned pre-cache algorithm and
//! FnvBuildHasher. It must not call the new helper or managed-string accessor.

use super::*;
use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::string::{WString, utils as string_utils};
use fnv::{FnvBuildHasher, FnvHasher};
use std::hash::BuildHasher;

fn original_hash_into<H: Hasher>(s: &WStr, state: &mut H) {
    s.iter()
        .for_each(|c| string_utils::swf_to_lowercase(c).hash(state));
    state.write_u8(0xff);
}

fn original_hash(s: &WStr) -> u64 {
    let mut state = FnvHasher::default();
    original_hash_into(s, &mut state);
    state.finish()
}

#[derive(Clone, PartialEq, Eq)]
struct OriginalName<'gc>(AvmString<'gc>);

impl Hash for OriginalName<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        original_hash_into(self.0.as_wstr(), state);
    }
}

struct OriginalQuery<'a> {
    key: &'a WStr,
    case_sensitive: bool,
}

impl Hash for OriginalQuery<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        original_hash_into(self.key, state);
    }
}

impl<'gc> Equivalent<OriginalName<'gc>> for OriginalQuery<'_> {
    fn equivalent(&self, key: &OriginalName<'gc>) -> bool {
        if self.case_sensitive {
            key.0 == self.key
        } else {
            key.0.eq_ignore_case(self.key)
        }
    }
}

type OriginalMap<'gc> = IndexMap<OriginalName<'gc>, u32, FnvBuildHasher>;

fn original_insert<'gc>(
    map: &mut OriginalMap<'gc>,
    key: AvmString<'gc>,
    value: u32,
    case_sensitive: bool,
) -> Option<u32> {
    let query = OriginalQuery { key: key.as_wstr(), case_sensitive };
    match map.get_index_of(&query) {
        Some(index) => Some(std::mem::replace(map.get_index_mut(index).unwrap().1, value)),
        None => {
            map.insert(OriginalName(key), value);
            None
        }
    }
}

fn key<'gc>(activation: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), value)
}

fn compare_maps<'gc>(
    actual: &PropertyMap<'gc, u32>,
    original: &OriginalMap<'gc>,
    queries: &[AvmString<'gc>],
) {
    let actual_order: Vec<_> = actual.iter().map(|(key, value)| (key, *value)).collect();
    let original_order: Vec<_> = original.iter().rev().map(|(key, value)| (key.0, *value)).collect();
    assert_eq!(actual_order, original_order);
    for query in queries {
        for case_sensitive in [true, false] {
            let original_query = OriginalQuery { key: query.as_wstr(), case_sensitive };
            let expected = original.get(&original_query);
            assert_eq!(actual.get_avm(*query, case_sensitive), expected);
            assert_eq!(actual.get(query.as_wstr(), case_sensitive), expected);
            assert_eq!(actual.contains_key_avm(*query, case_sensitive), expected.is_some());
            assert_eq!(actual.contains_key(query.as_wstr(), case_sensitive), expected.is_some());
            let expected_hash = original.hasher().hash_one(&original_query);
            let actual_hash = if case_sensitive {
                actual.0.hasher().hash_one(CaseSensitive(*query))
            } else {
                actual.0.hasher().hash_one(CaseInsensitive(*query))
            };
            assert_eq!(actual_hash, expected_hash);
        }
    }
}

#[test]
fn property_hash_exhaustive_utf16_units_match_original_fnv() {
    // Includes the complete Flash table, Latin-1, embedded NUL and all lone
    // high/low surrogates. Prefix/suffix contexts catch width/delimiter errors.
    for unit in 0..=u16::MAX {
        let single = [unit];
        let surrounded = [b'B' as u16, 0, unit, 0xd800, b'Z' as u16, 0xff];
        for units in [&single[..], &surrounded[..]] {
            let value = WStr::from_units(units);
            assert_eq!(avm1_property_hash(value), original_hash(value), "unit={unit:#06x}");
        }
    }
}

#[test]
fn property_hash_narrow_and_wide_inputs_keep_original_stream() {
    for byte in 0..=u8::MAX {
        let bytes = [b'A', byte, 0, b'Z'];
        let wide = [u16::from(b'A'), u16::from(byte), 0, u16::from(b'Z')];
        let narrow = WStr::from_units(&bytes[..]);
        let wide = WStr::from_units(&wide[..]);
        assert_eq!(avm1_property_hash(narrow), original_hash(narrow));
        assert_eq!(avm1_property_hash(wide), original_hash(wide));
        assert_eq!(avm1_property_hash(narrow), avm1_property_hash(wide));
    }
    let empty_bytes: [u8; 0] = [];
    let empty_wide: [u16; 0] = [];
    for empty in [WStr::from_units(&empty_bytes[..]), WStr::from_units(&empty_wide[..])] {
        assert_eq!(avm1_property_hash(empty), original_hash(empty));
    }
    let boundary_names: [&[u16]; 5] = [
        &[0x41], &[0x41, 0], &[0x41, 0xff], &[0x41, 0xffff], &[0xd800, 0xdc00, 0],
    ];
    for units in boundary_names {
        let value = WStr::from_units(units);
        assert_eq!(avm1_property_hash(value), original_hash(value));
    }
    let long: Vec<u16> = (0..4096).map(|index| ((index * 131) & 0xffff) as u16).collect();
    let long = WStr::from_units(&long[..]);
    assert_eq!(avm1_property_hash(long), original_hash(long));
}

#[test]
fn property_hash_cache_is_independent_for_slices_and_inline_concat() {
    with_avm(8, |activation, _| {
        for wide in [false, true] {
            let mut storage = WString::with_capacity(64, wide);
            storage.push_str(WStr::from_units(b"Parent"));
            let owner = AvmString::new(activation.gc(), storage);
            let slice = AvmString::substring(activation.gc(), owner, 1, 6);
            let prefix = AvmString::substring(activation.gc(), owner, 0, 3);
            let before: Vec<_> = [owner, slice, prefix].iter().map(|s| s.avm1_property_hash()).collect();

            let mut suffix_storage = WString::with_capacity(8, wide);
            suffix_storage.push_str(WStr::from_units(b"XY"));
            let suffix = AvmString::new(activation.gc(), suffix_storage);
            let appended = AvmString::concat(activation.gc(), owner, suffix);
            assert!(appended.is_dependent(), "fixture must exercise the in-place append path");
            let appended_slice = AvmString::substring(activation.gc(), appended, 1, appended.len());
            let twice = AvmString::concat(activation.gc(), appended, suffix);
            assert!(twice.is_dependent());
            for (index, old) in [owner, slice, prefix].iter().enumerate() {
                assert_eq!(old.avm1_property_hash(), before[index]);
                assert_eq!(old.avm1_property_hash(), original_hash(old.as_wstr()));
            }
            for value in [appended, appended_slice, twice, suffix] {
                let expected = original_hash(value.as_wstr());
                assert_eq!(value.avm1_property_hash(), expected);
                assert_eq!(value.avm1_property_hash(), expected);
            }
            assert_eq!(owner.as_wstr(), WStr::from_units(b"Parent"));
            assert_eq!(twice.as_wstr(), WStr::from_units(b"ParentXYXY"));
        }
        Ok(())
    });
}

#[test]
fn property_hash_static_interned_and_owned_strings_share_exact_hash() {
    with_avm(8, |activation, _| {
        let static_name = AvmString::new_ascii_static(activation.gc(), b"BH_Process");
        let owned = key(activation, "BH_Process");
        let wide_units: Vec<_> = "BH_Process".encode_utf16().collect();
        let wide = AvmString::new(activation.gc(), WStr::from_units(&wide_units[..]));
        let before = owned.avm1_property_hash();
        let atom = activation.context.strings.intern(owned);
        let interned: AvmString<'_> = atom.into();
        let independent = key(activation, "BH_Process");
        for value in [static_name, owned, wide, interned, independent] {
            assert_eq!(value.avm1_property_hash(), before);
            assert_eq!(value.avm1_property_hash(), original_hash(value.as_wstr()));
        }
        let owner = key(activation, "__BH_Process__");
        let dependent = AvmString::substring(activation.gc(), owner, 2, 12);
        let dependent_before = dependent.avm1_property_hash();
        let atom = activation.context.strings.intern(dependent);
        let interned: AvmString<'_> = atom.into();
        assert_eq!(dependent_before, before);
        assert_eq!(interned.avm1_property_hash(), before);
        assert_eq!(dependent.avm1_property_hash(), before);
        Ok(())
    });
}

#[test]
fn property_hash_mixed_case_queries_and_mutations_match_original_map() {
    with_avm(8, |activation, _| {
        let mut names: Vec<_> = [
            "name", "Name", "NAME", "nAmE", "other", "OTHER", "", "0", "00", "__proto__",
            "À", "à", "Σ", "σ", "İ", "i", "K", "K", "missing",
        ].iter().map(|text| key(activation, text)).collect();
        let unit_names: [&[u16]; 3] = [&[0, 0xd800, 65], &[0, 0xd800, 97], &[0xffff, 0xdc00]];
        for units in unit_names {
            names.push(AvmString::new(activation.gc(), WStr::from_units(units)));
        }
        // Repeated growth and shift-removal expose any changed hash bucket or
        // collision selection, including queries matching several case variants.
        for index in 0..96 {
            names.push(key(activation, &format!("Field{index}")));
            names.push(key(activation, &format!("field{index}")));
        }
        let mut actual = PropertyMap::new();
        let mut original = OriginalMap::default();
        for (index, name) in names.iter().enumerate() {
            assert_eq!(actual.insert(*name, index as u32, true), original_insert(&mut original, *name, index as u32, true));
        }
        compare_maps(&actual, &original, &names);

        for step in 0..1200usize {
            let name = names[(step * 73 + 11) % names.len()];
            let case_sensitive = step % 5 != 0;
            let query = OriginalQuery { key: name.as_wstr(), case_sensitive };
            match step % 5 {
                0 => assert_eq!(actual.insert(name, step as u32, case_sensitive), original_insert(&mut original, name, step as u32, case_sensitive)),
                1 => assert_eq!(actual.remove_avm(name, case_sensitive), original.shift_remove(&query)),
                2 => {
                    let left = actual.get_mut_avm(name, case_sensitive);
                    let right = original.get_mut(&query);
                    assert_eq!(left.as_deref(), right.as_deref());
                    if let Some(value) = left { *value = value.wrapping_add(7); }
                    if let Some(value) = right { *value = value.wrapping_add(7); }
                }
                3 => assert_eq!(actual.remove(name.as_wstr(), case_sensitive), original.shift_remove(&query)),
                _ => {
                    let expected = original.get_index_of(&query);
                    match actual.entry(name, case_sensitive) {
                        Entry::Occupied(mut entry) => {
                            let index = expected.expect("original occupied");
                            assert_eq!(*entry.get(), *original.get_index(index).unwrap().1);
                            *entry.get_mut() = step as u32;
                            *original.get_index_mut(index).unwrap().1 = step as u32;
                        }
                        Entry::Vacant(entry) => {
                            assert!(expected.is_none());
                            entry.insert(step as u32);
                            original.insert(OriginalName(name), step as u32);
                        }
                    }
                }
            }
            if step % 37 == 0 { compare_maps(&actual, &original, &names); }
        }
        compare_maps(&actual, &original, &names);
        Ok(())
    });
}

#[test]
fn property_hash_clone_borrowed_mutation_and_entry_removal_preserve_order() {
    with_avm(8, |activation, _| {
        let names = [key(activation, "First"), key(activation, "first"), key(activation, "Last")];
        let mut actual = PropertyMap::new();
        let mut original = OriginalMap::default();
        for (index, name) in names.iter().enumerate() {
            actual.insert(*name, index as u32, true);
            original_insert(&mut original, *name, index as u32, true);
        }
        let mut cloned = actual.clone();
        for (index, (_name, value)) in cloned.iter_mut().enumerate() { *value += 10 + index as u32; }
        assert_eq!(actual.get_index(0), Some(&0));
        assert_eq!(cloned.get_index(0), Some(&12));
        let borrowed = WStr::from_units(b"FIRST");
        let original_query = OriginalQuery { key: borrowed, case_sensitive: false };
        *actual.get_mut(borrowed, false).unwrap() += 20;
        *original.get_mut(&original_query).unwrap() += 20;
        compare_maps(&actual, &original, &names);
        if let Entry::Occupied(mut entry) = actual.entry(names[0], false) {
            let index = original.get_index_of(&OriginalQuery { key: names[0].as_wstr(), case_sensitive: false }).unwrap();
            let expected = original.shift_remove_index(index).unwrap();
            let removed = entry.remove_entry();
            assert_eq!(removed, (expected.0.0, expected.1));
        } else {
            panic!("expected original occupied entry");
        }
        compare_maps(&actual, &original, &names);
        assert_eq!(cloned.iter().count(), 3, "clone has no cached membership from its source");
        Ok(())
    });
}

#[test]
fn property_hash_cached_misses_observe_new_own_and_inherited_properties() {
    for version in [6, 8] {
        with_avm(version, |activation, _| {
            let proto = Object::new(&activation.context.strings, Some(activation.prototypes().object));
            let child = Object::new(&activation.context.strings, Some(proto));
            let name = key(activation, "Later");
            for _ in 0..3 { assert_eq!(child.get(name, activation)?, Value::Undefined); }
            proto.define_value(activation.gc(), name, 10.0.into(), Attribute::empty());
            assert_eq!(child.get(name, activation)?, 10.0.into());
            child.define_value(activation.gc(), name, 20.0.into(), Attribute::empty());
            assert_eq!(child.get(name, activation)?, 20.0.into());
            assert!(child.delete(activation, name));
            assert_eq!(child.get(name, activation)?, 10.0.into());
            proto.set(name, 30.0, activation)?;
            assert_eq!(child.get(name, activation)?, 30.0.into());
            assert!(proto.delete(activation, name));
            assert_eq!(child.get(name, activation)?, Value::Undefined);
            Ok(())
        });
    }
}

#[test]
fn property_hash_cached_names_preserve_swf_case_and_attribute_rules() {
    for version in [6, 8] {
        with_avm(version, |activation, _| {
            let object = Object::new_without_proto(activation.gc());
            let upper = key(activation, "Thing");
            let lower = key(activation, "thing");
            let query = key(activation, "THING");
            let mut original = OriginalMap::default();
            object.define_value(activation.gc(), upper, 1.0.into(), Attribute::empty());
            object.define_value(activation.gc(), lower, 2.0.into(), Attribute::empty());
            original_insert(&mut original, upper, 1, true);
            original_insert(&mut original, lower, 2, true);
            for name in [upper, lower, query] {
                let expected = original.get(&OriginalQuery { key: name.as_wstr(), case_sensitive: version >= 7 });
                let expected = expected.map_or(Value::Undefined, |value| Value::Number(f64::from(*value)));
                assert_eq!(object.get(name, activation)?, expected);
                assert_eq!(object.get(name, activation)?, expected);
            }
            let protected = key(activation, "protected");
            object.define_value(activation.gc(), protected, 9.0.into(), Attribute::READ_ONLY | Attribute::DONT_DELETE | Attribute::DONT_ENUM);
            let _ = protected.avm1_property_hash();
            object.set(protected, 99.0, activation)?;
            assert_eq!(object.get(protected, activation)?, 9.0.into());
            assert!(!object.delete(activation, protected));
            assert!(!object.get_keys(activation, false).contains(&protected));
            object.set_attributes(activation.gc(), Some(protected), Attribute::empty(), Attribute::READ_ONLY | Attribute::DONT_DELETE | Attribute::DONT_ENUM);
            object.set(protected, 11.0, activation)?;
            assert_eq!(object.get(protected, activation)?, 11.0.into());
            assert!(object.get_keys(activation, false).contains(&protected));
            assert!(object.delete(activation, protected));
            Ok(())
        });
    }
}

fn function<'gc>(activation: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&activation.context.strings, None, None)
}

fn increment<'gc>(activation: &mut Activation<'_, 'gc>, name: &str) -> f64 {
    let global = activation.global_object();
    let name = key(activation, name);
    let previous = match global.get_data(name, activation) { Some(Value::Number(value)) => value, _ => 0.0 };
    global.define_value(activation.gc(), name, (previous + 1.0).into(), Attribute::empty());
    previous + 1.0
}

fn counted_getter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    Ok(increment(activation, "hashFixtureGets").into())
}

fn counted_setter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(activation, "hashFixtureSets");
    let global = activation.global_object();
    global.define_value(activation.gc(), key(activation, "hashFixtureLastSet"), args[0], Attribute::empty());
    Ok(Value::Undefined)
}

fn counted_watcher<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(activation, "hashFixtureWatches");
    Ok(args[2])
}

#[test]
fn property_hash_cached_names_still_run_getters_setters_and_watchers() {
    with_avm(8, |activation, _| {
        let object = Object::new(&activation.context.strings, Some(activation.prototypes().object));
        let virtual_name = key(activation, "virtual");
        let stored_name = key(activation, "stored");
        object.add_property(activation.gc(), virtual_name, function(activation, counted_getter), Some(function(activation, counted_setter)), Attribute::empty());
        for expected in 1..=4 {
            assert_eq!(object.get(virtual_name, activation)?, Value::Number(f64::from(expected)));
        }
        object.set(virtual_name, 41.0, activation)?;
        object.set(virtual_name, 42.0, activation)?;
        let global = activation.global_object();
        assert_eq!(global.get_data(key(activation, "hashFixtureSets"), activation), Some(2.0.into()));
        assert_eq!(global.get_data(key(activation, "hashFixtureLastSet"), activation), Some(42.0.into()));

        object.define_value(activation.gc(), stored_name, 0.0.into(), Attribute::empty());
        let watcher = function(activation, counted_watcher);
        object.watch(activation, stored_name, watcher, Value::Undefined);
        for value in 1..=3 {
            object.set(stored_name, f64::from(value), activation)?;
            assert_eq!(object.get(stored_name, activation)?, Value::Number(f64::from(value)));
        }
        assert_eq!(global.get_data(key(activation, "hashFixtureWatches"), activation), Some(3.0.into()));
        assert!(object.unwatch(activation, stored_name));
        object.set(stored_name, 4.0, activation)?;
        assert_eq!(global.get_data(key(activation, "hashFixtureWatches"), activation), Some(3.0.into()));
        assert_eq!(object.get(stored_name, activation)?, 4.0.into());
        Ok(())
    });
}
