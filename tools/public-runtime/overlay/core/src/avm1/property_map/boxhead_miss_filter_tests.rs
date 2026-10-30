//! A negative-only map filter must never hide a live key or cache a VM result.
//! The pinned prior table is the independent lookup/order oracle. Queries below
//! deliberately invalidate positive hints so a missing filter bit cannot hide
//! behind the older fast path. Original getter/prototype/display endpoints also
//! run without exposing or mutating their private PropertyMaps.

use super::*;
use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::{ExecutionReason, FunctionObject, NativeFunction};
use crate::avm1::object::search_prototype;
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::string::WString;
use std::collections::BTreeMap;

#[path = "frozen_v8.rs"]
mod frozen_v8;

fn key<'gc>(a: &Activation<'_, 'gc>, text: &str) -> AvmString<'gc> {
    AvmString::new_utf8(a.gc(), text)
}

fn fresh<'gc>(a: &Activation<'_, 'gc>, name: AvmString<'gc>) -> AvmString<'gc> {
    let result = AvmString::new(a.gc(), name.as_wstr());
    assert_eq!(result.avm1_property_index_hint(), None);
    result
}

fn compare<'gc>(
    actual: &PropertyMap<'gc, u32>,
    frozen: &frozen_v8::PropertyMap<'gc, u32>,
    queries: &[AvmString<'gc>],
) {
    let actual_order: Vec<_> = actual.iter()
        .map(|(name, value)| (name.iter().collect::<Vec<_>>(), *value)).collect();
    let frozen_order: Vec<_> = frozen.iter()
        .map(|(name, value)| (name.iter().collect::<Vec<_>>(), *value)).collect();
    assert_eq!(actual_order, frozen_order);
    for index in 0..=frozen_order.len() {
        assert_eq!(actual.get_index(index), frozen.get_index(index));
    }
    for &query in queries {
        for sensitive in [true, false] {
            let expected = frozen.get_avm(query, sensitive);
            query.cache_avm1_property_index(999_999);
            assert_eq!(actual.get_avm(query, sensitive), expected);
            query.cache_avm1_property_index(999_999);
            assert_eq!(actual.contains_key_avm(query, sensitive), expected.is_some());
            assert_eq!(actual.get(query.as_wstr(), sensitive), expected);
            assert_eq!(actual.contains_key(query.as_wstr(), sensitive), expected.is_some());
        }
    }
}

#[test]
fn property_miss_filter_new_default_and_all_insert_paths_preserve_unhinted_hits() {
    with_avm(8, |a, _| {
        for use_default in [false, true] {
            let mut actual: PropertyMap<'_, u32> = if use_default {
                PropertyMap::default()
            } else {
                PropertyMap::new()
            };
            let mut frozen = frozen_v8::PropertyMap::new();
            let absent = key(a, "InitiallyAbsent");
            assert_eq!(actual.1, [0; 2]);
            assert_eq!(actual.get_avm(absent, true), None);
            assert_eq!(absent.avm1_property_index_hint(), None);
            let mut names = vec![absent];
            for (index, (sensitive, direct_entry)) in
                [(true, false), (false, false), (true, true), (false, true)].into_iter().enumerate()
            {
                let name = key(a, &format!("Inserted_{index}"));
                let value = index as u32 + 1;
                if direct_entry {
                    match (actual.entry(name, sensitive), frozen.entry(name, sensitive)) {
                        (Entry::Vacant(left), frozen_v8::Entry::Vacant(right)) => {
                            left.insert(value);
                            right.insert(value);
                        }
                        _ => panic!("new key unexpectedly occupied"),
                    }
                } else {
                    assert_eq!(actual.insert(name, value, sensitive), None);
                    assert_eq!(frozen.insert(name, value, sensitive), None);
                }
                // A case-insensitive insert must also admit a later exact query.
                let query = fresh(a, name);
                assert_eq!(actual.get_avm(query, true), Some(&value));
                let query = fresh(a, name);
                *actual.get_mut_avm(query, true).expect("live exact key") += 10;
                *frozen.get_mut_avm(query, true).expect("oracle live key") += 10;
                names.push(name);
                compare(&actual, &frozen, &names);
            }
        }
        Ok(())
    });
}

#[test]
fn property_miss_filter_abandoned_vacant_entries_never_create_membership() {
    with_avm(8, |a, _| {
        let mut actual: PropertyMap<'_, u32> = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        for sensitive in [true, false] {
            let name = key(a, if sensitive { "AbandonedExact" } else { "AbandonedFolded" });
            assert!(matches!(actual.entry(name, sensitive), Entry::Vacant(_)));
            assert!(matches!(frozen.entry(name, sensitive), frozen_v8::Entry::Vacant(_)));
            // The permitted extra bits must not be interpreted as an entry.
            assert!(actual.may_contain_key(name));
            assert_eq!(actual.iter().count(), 0);
            compare(&actual, &frozen, &[name]);
            match (actual.entry(name, sensitive), frozen.entry(name, sensitive)) {
                (Entry::Vacant(left), frozen_v8::Entry::Vacant(right)) => {
                    left.insert(7);
                    right.insert(7);
                }
                _ => panic!("abandoned vacant entry changed occupancy"),
            }
            assert_eq!(actual.get_avm(fresh(a, name), true), Some(&7));
            assert_eq!(actual.remove_avm(name, true), Some(7));
            assert_eq!(frozen.remove_avm(name, true), Some(7));
            compare(&actual, &frozen, &[name]);
        }
        Ok(())
    });
}

#[test]
fn property_miss_filter_zero_hash_collisions_and_saturation_keep_exact_fallback() {
    assert_eq!(property_miss_bits(0), [1, 1]);
    assert_eq!(property_miss_bits(u64::MAX), [1u32 << 31, 1u32 << 31]);
    assert_eq!(property_miss_bits(1u64 << 32), [1, 2]);
    assert_eq!(std::mem::size_of::<[u32; 2]>(), 8);
    assert_eq!(std::mem::align_of::<[u32; 2]>(), std::mem::align_of::<u32>());
    with_avm(8, |a, _| {
        let mut seen = BTreeMap::new();
        let mut collision = None;
        // Two 32-bit one-hot lanes have only 1024 different bit pairs.
        for index in 0..=1024 {
            let name = key(a, &format!("FilterCollision_{index}"));
            let bits = property_miss_bits(name.avm1_property_hash());
            if let Some(previous) = seen.insert(bits, name) {
                collision = Some((previous, name));
                break;
            }
        }
        let (stored, absent) = collision.expect("1025 distinct names must share a bit pair");
        assert_ne!(stored, absent);
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        actual.insert(stored, 17u32, true);
        frozen.insert(stored, 17u32, true);
        assert!(actual.may_contain_key(absent));
        compare(&actual, &frozen, &[stored, absent]);

        // Also exercise a real negative rejection, not an always-positive stub.
        let rejected = (0..1024).map(|index| key(a, &format!("DifferentBits_{index}")))
            .find(|&name| !actual.may_contain_key(name)).expect("sparse map has absent bit pairs");
        assert_eq!(actual.get_avm(rejected, true), None);
        assert_eq!(rejected.avm1_property_index_hint(), None);

        // All-ones is the legal worst case after many removed/abandoned keys.
        actual.1 = [u32::MAX; 2];
        compare(&actual, &frozen, &[stored, absent, rejected]);
        absent.cache_avm1_property_index(0);
        assert_eq!(actual.get_avm(absent, true), None);
        assert_eq!(absent.avm1_property_index_hint(), Some(0));
        Ok(())
    });
}

#[test]
fn property_miss_filter_casefold_utf16_and_range_aliases_match_frozen_table() {
    with_avm(8, |a, _| {
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        let mut queries = Vec::new();
        let mut names: Vec<_> = ["Health", "health", "HEALTH", "", "A\0Z"]
            .iter().map(|text| key(a, text)).collect();
        for units in [&[0xd800u16][..], &[0xdc00u16][..], &[0x03a3u16, 0][..], &[0x03c3u16, 0][..]] {
            names.push(AvmString::new(a.gc(), WStr::from_units(units)));
        }
        let mut buffer = WString::with_capacity(64, false);
        buffer.push_str(WStr::from_units(b"Asset"));
        let owner = AvmString::new(a.gc(), buffer);
        names.push(owner);
        for (index, &name) in names.iter().enumerate() {
            assert_eq!(actual.insert(name, index as u32, true), frozen.insert(name, index as u32, true));
            queries.extend([name, fresh(a, name)]);
            let wide: Vec<u16> = name.iter().collect();
            queries.push(AvmString::new(a.gc(), WStr::from_units(&wide[..])));
        }
        // Appending may reuse the backing allocation, not the old immutable range.
        let appended = AvmString::concat(a.gc(), owner, key(a, "Suffix"));
        queries.extend([appended, AvmString::substring(a.gc(), appended, 0, 5)]);
        let atom: AvmString<'_> = a.context.strings.intern(owner).into();
        queries.push(atom);
        queries.push(key(a, "hEaLtH"));
        compare(&actual, &frozen, &queries);
        let folded = key(a, "hEaLtH");
        match (actual.entry(folded, false), frozen.entry(folded, false)) {
            (Entry::Occupied(left), frozen_v8::Entry::Occupied(right)) => {
                assert_eq!(left.insert(99), right.insert(99));
            }
            _ => panic!("folded alias must select an existing exact spelling"),
        }
        compare(&actual, &frozen, &queries);
        Ok(())
    });
}

#[test]
fn property_miss_filter_all_deletions_and_reinsertion_keep_live_keys_and_order() {
    with_avm(8, |a, _| {
        let names = [key(a, "First"), key(a, "Target"), key(a, "After")];
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        for (index, &name) in names.iter().enumerate() {
            actual.insert(name, index as u32, true);
            frozen.insert(name, index as u32, true);
        }
        let before = actual.1;
        assert_eq!(actual.remove(names[0].as_wstr(), true), frozen.remove(names[0].as_wstr(), true));
        compare(&actual, &frozen, &names);
        match (actual.entry(names[1], true), frozen.entry(names[1], true)) {
            (Entry::Occupied(mut left), frozen_v8::Entry::Occupied(mut right)) => {
                assert_eq!(left.remove_entry(), right.remove_entry());
            }
            _ => panic!("surviving shifted key was hidden"),
        }
        assert_eq!(actual.remove_avm(names[2], false), frozen.remove_avm(names[2], false));
        assert_eq!(actual.1, before, "deletion must not clear another key's possible bits");
        compare(&actual, &frozen, &names);
        for (index, &name) in names.iter().rev().enumerate() {
            assert_eq!(actual.insert(name, index as u32 + 10, false), frozen.insert(name, index as u32 + 10, false));
        }
        compare(&actual, &frozen, &names);
        Ok(())
    });
}

#[test]
fn property_miss_filter_clone_take_swap_and_value_mutation_preserve_coverage() {
    with_avm(8, |a, _| {
        let names = [key(a, "Left"), key(a, "Right"), key(a, "New")];
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        actual.insert(names[0], 1u32, true); frozen.insert(names[0], 1u32, true);
        actual.insert(names[1], 2, false); frozen.insert(names[1], 2, false);
        let mut cloned = actual.clone();
        let mut frozen_clone = frozen.clone();
        assert_eq!(cloned.remove_avm(names[0], true), frozen_clone.remove_avm(names[0], true));
        cloned.insert(names[2], 3, true); frozen_clone.insert(names[2], 3, true);
        *cloned.get_mut_avm(fresh(a, names[1]), true).expect("clone has Right") += 10;
        *frozen_clone.get_mut_avm(names[1], true).expect("oracle has Right") += 10;
        *cloned.get_mut(names[2].as_wstr(), true).expect("clone has New") += 20;
        *frozen_clone.get_mut(names[2].as_wstr(), true).expect("oracle has New") += 20;
        for (_, value) in cloned.iter_mut() { *value += 1; }
        for (_, value) in frozen_clone.iter_mut() { *value += 1; }
        compare(&cloned, &frozen_clone, &names);
        compare(&actual, &frozen, &names);
        let mut copied = PropertyMap::default();
        let mut frozen_copied = frozen_v8::PropertyMap::default();
        copied.clone_from(&cloned); frozen_copied.clone_from(&frozen_clone);
        compare(&copied, &frozen_copied, &names);
        let moved = std::mem::take(&mut actual);
        let frozen_moved = std::mem::take(&mut frozen);
        assert_eq!(actual.1, [0; 2]);
        compare(&actual, &frozen, &names);
        compare(&moved, &frozen_moved, &names);
        std::mem::swap(&mut actual, &mut copied);
        std::mem::swap(&mut frozen, &mut frozen_copied);
        compare(&actual, &frozen, &names);
        compare(&copied, &frozen_copied, &names);
        Ok(())
    });
}

fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&a.context.strings, None, None)
}

fn increment<'gc>(a: &mut Activation<'_, 'gc>, counter: &str) -> f64 {
    let global = a.global_object();
    let name = key(a, counter);
    let previous = match global.get_data(name, a) { Some(Value::Number(value)) => value, _ => 0.0 };
    global.define_value(a.gc(), name, (previous + 1.0).into(), Attribute::empty());
    previous + 1.0
}

fn getter<'gc>(a: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    Ok(increment(a, "filterGets").into())
}

fn setter<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(a, "filterSets");
    let global = a.global_object();
    global.define_value(a.gc(), key(a, "filterSetThis"), this.into(), Attribute::empty());
    global.define_value(a.gc(), key(a, "filterSetValue"), args[0], Attribute::empty());
    Ok(Value::Undefined)
}

fn watcher<'gc>(a: &mut Activation<'_, 'gc>, _: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(a, "filterWatches");
    Ok(args[2])
}

fn resolver<'gc>(a: &mut Activation<'_, 'gc>, this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(a, "filterResolves");
    let [Value::String(name)] = args else { panic!("resolver receives the original name"); };
    let global = a.global_object();
    global.define_value(a.gc(), key(a, "filterResolveThis"), this.into(), Attribute::empty());
    global.define_value(a.gc(), key(a, "filterResolveName"), (*name).into(), Attribute::empty());
    this.define_value(a.gc(), *name, 77.0.into(), Attribute::empty());
    Ok(91.0.into())
}

fn throwing_getter<'gc>(a: &mut Activation<'_, 'gc>, _: Object<'gc>, _: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(a, "filterThrows");
    Err(Error::ThrownValue(key(a, "filter-sentinel").into()))
}

#[test]
fn property_miss_filter_actual_prototype_reads_observe_later_writes_and_reparenting() {
    for version in [6, 8] {
        with_avm(version, |a, _| {
            let proto = Object::new_without_proto(a.gc());
            let other = Object::new_without_proto(a.gc());
            let child = Object::new(&a.context.strings, Some(proto));
            let name = key(a, "Later");
            for _ in 0..3 { assert_eq!(child.get(name, a)?, Value::Undefined); }
            proto.define_value(a.gc(), name, 7.0.into(), Attribute::empty());
            assert_eq!(child.get(fresh(a, name), a)?, 7.0.into());
            child.set(name, 11.0, a)?;
            assert_eq!(child.get(fresh(a, name), a)?, 11.0.into());
            assert!(child.delete(a, name));
            proto.set(name, 9.0, a)?;
            assert_eq!(child.get(fresh(a, name), a)?, 9.0.into());
            other.define_value(a.gc(), name, 17.0.into(), Attribute::empty());
            child.set_data(key(a, "__proto__"), other.into(), a)?;
            assert_eq!(child.get(fresh(a, name), a)?, 17.0.into());
            assert!(other.delete(a, name));
            assert_eq!(child.get(fresh(a, name), a)?, Value::Undefined);
            assert_eq!(proto.get(name, a)?, 9.0.into());
            Ok(())
        });
    }
}

#[test]
fn property_miss_filter_actual_getters_setters_and_watchers_keep_callbacks() {
    with_avm(8, |a, _| {
        let proto = Object::new_without_proto(a.gc());
        let child = Object::new(&a.context.strings, Some(proto));
        let virtual_name = key(a, "Virtual");
        let stored_name = key(a, "Stored");
        assert_eq!(child.get(virtual_name, a)?, Value::Undefined);
        assert_eq!(child.get(stored_name, a)?, Value::Undefined);
        proto.add_property(a.gc(), virtual_name, function(a, getter), Some(function(a, setter)), Attribute::empty());
        for expected in 1..=3 {
            assert_eq!(child.get(fresh(a, virtual_name), a)?, Value::Number(f64::from(expected)));
        }
        child.set(virtual_name, 41.0, a)?;
        let global = a.global_object();
        assert_eq!(global.get_data(key(a, "filterSets"), a), Some(1.0.into()));
        assert_eq!(global.get_data(key(a, "filterSetThis"), a), Some(child.into()));
        assert_eq!(global.get_data(key(a, "filterSetValue"), a), Some(41.0.into()));
        child.define_value(a.gc(), stored_name, 0.0.into(), Attribute::empty());
        let watch = function(a, watcher);
        child.watch(a, stored_name, watch, Value::Undefined);
        for value in 1..=3 {
            child.set(stored_name, f64::from(value), a)?;
            assert_eq!(child.get(fresh(a, stored_name), a)?, Value::Number(f64::from(value)));
        }
        assert_eq!(global.get_data(key(a, "filterWatches"), a), Some(3.0.into()));
        assert!(child.unwatch(a, stored_name));
        child.set(stored_name, 4.0, a)?;
        assert_eq!(child.get(stored_name, a)?, 4.0.into());
        assert_eq!(global.get_data(key(a, "filterWatches"), a), Some(3.0.into()));
        Ok(())
    });
}

#[test]
fn property_miss_filter_actual_resolve_mutation_and_thrown_getter_stay_fresh() {
    with_avm(8, |a, _| {
        let proto = Object::new_without_proto(a.gc());
        let child = Object::new(&a.context.strings, Some(proto));
        let name = key(a, "ResolvedLater");
        assert!(search_prototype(child.into(), name, a, child, true)?.is_none());
        proto.define_value(a.gc(), key(a, "__resolve"), function(a, resolver).into(), Attribute::empty());
        assert!(search_prototype(child.into(), name, a, child, false)?.is_none());
        assert_eq!(search_prototype(child.into(), name, a, child, true)?, Some((91.0.into(), 0)));
        assert_eq!(child.get(fresh(a, name), a)?, 77.0.into());
        let global = a.global_object();
        assert_eq!(global.get_data(key(a, "filterResolves"), a), Some(1.0.into()));
        assert_eq!(global.get_data(key(a, "filterResolveThis"), a), Some(child.into()));
        assert_eq!(global.get_data(key(a, "filterResolveName"), a), Some(name.into()));
        assert!(child.delete(a, name));
        assert_eq!(child.get(fresh(a, name), a)?, 91.0.into());
        assert_eq!(global.get_data(key(a, "filterResolves"), a), Some(2.0.into()));
        let throwing = key(a, "ThrowsLater");
        proto.add_property(a.gc(), throwing, function(a, throwing_getter), None, Attribute::empty());
        for _ in 0..2 {
            match child.get(fresh(a, throwing), a) {
                Err(Error::ThrownValue(value)) => assert_eq!(value, key(a, "filter-sentinel").into()),
                other => panic!("original thrown value was hidden: {other:?}"),
            }
        }
        assert_eq!(global.get_data(key(a, "filterThrows"), a), Some(2.0.into()));
        Ok(())
    });
}

#[test]
fn property_miss_filter_actual_movieclip_fallback_and_own_shadowing_are_preserved() {
    with_avm(8, |a, root| {
        let x = key(a, "_x");
        root.delete(a, x);
        assert!(!root.has_own_property(a, x));
        assert_eq!(root.get(fresh(a, x), a)?, 0.0.into());
        root.define_value(a.gc(), x, Value::Undefined, Attribute::empty());
        assert_eq!(root.get(fresh(a, x), a)?, Value::Undefined);
        assert!(root.delete(a, x));
        assert_eq!(root.get(fresh(a, x), a)?, 0.0.into());
        let name = key(a, "filterChild");
        assert_eq!(root.get(name, a)?, Value::Undefined);
        let value = root.call_method(key(a, "createEmptyMovieClip"), &[name.into(), 1.0.into()], a, ExecutionReason::FunctionCall)?;
        let child = value.as_object(a).expect("original createEmptyMovieClip result");
        assert!(!root.has_own_property(a, name));
        let resolved = root.get(fresh(a, name), a)?.as_object(a).expect("live named display child");
        assert!(Object::ptr_eq(child, resolved));
        root.define_value(a.gc(), name, Value::Undefined, Attribute::empty());
        assert_eq!(root.get(fresh(a, name), a)?, Value::Undefined);
        assert!(root.delete(a, name));
        let restored = root.get(fresh(a, name), a)?.as_object(a).expect("display child after own deletion");
        assert!(Object::ptr_eq(child, restored));
        Ok(())
    });
}
