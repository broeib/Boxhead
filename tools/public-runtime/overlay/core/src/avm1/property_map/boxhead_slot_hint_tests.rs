//! Positive slot hints are only a shortcut to a freshly checked map key.
//! These fixtures deliberately stale the hint through real map mutations and
//! shared query names. The frozen case-insensitive oracle remains unchanged.

use super::*;
use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::string::WString;

#[path = "frozen_v8.rs"]
mod frozen_v8;

fn owned<'gc>(activation: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), value)
}

fn snapshot(map: &PropertyMap<'_, u32>) -> Vec<(Vec<u16>, u32)> {
    map.iter()
        .map(|(name, value)| (name.iter().collect(), *value))
        .collect()
}

fn frozen_snapshot(map: &frozen_v8::PropertyMap<'_, u32>) -> Vec<(Vec<u16>, u32)> {
    map.iter()
        .map(|(name, value)| (name.iter().collect(), *value))
        .collect()
}

#[test]
fn slot_hint_positive_queries_recheck_wrong_keys_and_out_of_bounds_indices() {
    with_avm(8, |activation, _| {
        let first = owned(activation, "first");
        let second = owned(activation, "second");
        let stored = owned(activation, "target");
        let query = owned(activation, "target");
        let missing = owned(activation, "missing");
        let mut map = PropertyMap::new();
        map.insert(first, 10u32, true);
        map.insert(second, 20, true);
        map.insert(stored, 30, true);
        assert_eq!(query.avm1_property_index_hint(), None);
        assert!(map.contains_key_avm(query, true));
        assert_eq!(query.avm1_property_index_hint(), Some(2));

        query.cache_avm1_property_index(0);
        assert_eq!(map.get_avm(query, true), Some(&30));
        assert_eq!(query.avm1_property_index_hint(), Some(2));
        query.cache_avm1_property_index(999);
        *map.get_mut_avm(query, true).expect("target exists") = 31;
        assert_eq!(query.avm1_property_index_hint(), Some(2));
        assert_eq!(map.get_avm(query, true), Some(&31));
        assert_eq!(map.get_avm(first, true), Some(&10));

        assert!(!map.contains_key_avm(missing, true));
        assert_eq!(map.get_avm(missing, true), None);
        assert_eq!(missing.avm1_property_index_hint(), None);
        missing.cache_avm1_property_index(2);
        assert_eq!(map.get_mut_avm(missing, true), None);
        assert_eq!(missing.avm1_property_index_hint(), Some(2));
        map.insert(missing, 40, true);
        assert_eq!(map.get_avm(missing, true), Some(&40));
        assert_eq!(missing.avm1_property_index_hint(), Some(3));
        Ok(())
    });
}

#[test]
fn slot_hint_shared_query_revalidates_each_map_and_independently_mutated_clone() {
    with_avm(8, |activation, _| {
        let a = owned(activation, "a");
        let target = owned(activation, "target");
        let b = owned(activation, "b");
        let query = owned(activation, "target");
        let mut left = PropertyMap::new();
        let mut right = PropertyMap::new();
        for (key, value) in [(a, 1u32), (target, 10), (b, 2)] {
            left.insert(key, value, true);
        }
        for (key, value) in [(target, 20u32), (b, 3), (a, 4)] {
            right.insert(key, value, true);
        }
        let mut cloned = left.clone();
        assert_eq!(cloned.remove_avm(a, true), Some(1));
        cloned.insert(target, 30, true);
        for _ in 0..8 {
            assert_eq!(left.get_avm(query, true), Some(&10));
            assert_eq!(query.avm1_property_index_hint(), Some(1));
            assert_eq!(right.get_avm(query, true), Some(&20));
            assert_eq!(query.avm1_property_index_hint(), Some(0));
            assert_eq!(cloned.get_avm(query, true), Some(&30));
            assert_eq!(left.get_avm(query, true), Some(&10));
        }
        assert_eq!(cloned.remove_avm(target, true), Some(30));
        assert_eq!(cloned.get_avm(query, true), None);
        assert_eq!(left.get_avm(query, true), Some(&10));
        assert_eq!(right.get_avm(query, true), Some(&20));
        Ok(())
    });
}

#[test]
fn slot_hint_shift_remove_entry_remove_and_reinsert_preserve_order() {
    with_avm(8, |activation, _| {
        let first = owned(activation, "first");
        let target = owned(activation, "target");
        let after = owned(activation, "after");
        let query = owned(activation, "target");
        let mut map = PropertyMap::new();
        map.insert(first, 1u32, true);
        map.insert(target, 2, true);
        map.insert(after, 3, true);
        assert_eq!(map.get_avm(query, true), Some(&2));
        assert_eq!(query.avm1_property_index_hint(), Some(1));
        assert_eq!(map.remove(first.as_wstr(), true), Some(1));
        // Old slot 1 now names "after", so an in-range hint is still stale.
        assert_eq!(map.get_avm(query, true), Some(&2));
        assert_eq!(query.avm1_property_index_hint(), Some(0));
        match map.entry(query, true) {
            Entry::Occupied(mut entry) => assert_eq!(entry.remove_entry(), (target, 2)),
            Entry::Vacant(_) => panic!("existing target disappeared"),
        }
        // Slot 0 now names "after"; absence must not return its value.
        assert_eq!(map.get_avm(query, true), None);
        match map.entry(query, true) {
            Entry::Vacant(entry) => entry.insert(4),
            Entry::Occupied(_) => panic!("removed target remained occupied"),
        }
        assert_eq!(map.get_avm(query, true), Some(&4));
        assert_eq!(query.avm1_property_index_hint(), Some(1));
        let order: Vec<_> = map.iter().map(|(key, value)| (key, *value)).collect();
        assert_eq!(order, vec![(query, 4), (after, 3)]);
        assert_eq!(map.get_index(0), Some(&3));
        assert_eq!(map.get_index(1), Some(&4));
        assert_eq!(map.get_index(2), None);
        Ok(())
    });
}

#[test]
fn slot_hint_warm_reads_observe_insert_get_mut_entry_and_iter_mut_values() {
    with_avm(8, |activation, _| {
        let name = owned(activation, "value");
        let query = owned(activation, "value");
        let mut map = PropertyMap::new();
        map.insert(name, 1u32, true);
        assert_eq!(map.get_avm(query, true), Some(&1));
        assert_eq!(map.insert(name, 2, true), Some(1));
        assert_eq!(map.get_avm(query, true), Some(&2));
        *map.get_mut_avm(query, true).expect("warm target exists") = 3;
        assert_eq!(map.get_avm(query, true), Some(&3));
        match map.entry(query, true) {
            Entry::Occupied(mut entry) => {
                assert_eq!(entry.get(), &3);
                *entry.get_mut() = 4;
                assert_eq!(entry.insert(5), 4);
            }
            Entry::Vacant(_) => panic!("warm target disappeared"),
        }
        assert_eq!(map.get_avm(query, true), Some(&5));
        for (_, value) in map.iter_mut() {
            *value = 6;
        }
        assert_eq!(map.get_avm(query, true), Some(&6));
        Ok(())
    });
}

#[test]
fn slot_hint_case_insensitive_collisions_and_mutations_keep_frozen_selection() {
    with_avm(8, |activation, _| {
        let names = [
            owned(activation, "Thing"),
            owned(activation, "thing"),
            owned(activation, "THING"),
        ];
        let queries = [
            owned(activation, "Thing"),
            owned(activation, "thing"),
            owned(activation, "THING"),
            owned(activation, "tHiNg"),
            owned(activation, "absent"),
        ];
        for reverse in [false, true] {
            let mut actual = PropertyMap::new();
            let mut frozen = frozen_v8::PropertyMap::new();
            for step in 0..names.len() {
                let index = if reverse { names.len() - 1 - step } else { step };
                assert_eq!(
                    actual.insert(names[index], index as u32, true),
                    frozen.insert(names[index], index as u32, true),
                );
            }
            for (step, &query) in queries.iter().enumerate() {
                let hint = step % 3;
                query.cache_avm1_property_index(hint);
                assert_eq!(actual.get_avm(query, false), frozen.get_avm(query, false));
                assert_eq!(
                    actual.contains_key_avm(query, false),
                    frozen.contains_key_avm(query, false),
                );
                let actual_value = actual.get_mut_avm(query, false);
                let frozen_value = frozen.get_mut_avm(query, false);
                assert_eq!(actual_value.as_deref(), frozen_value.as_deref());
                if let Some(value) = actual_value {
                    *value += 10;
                }
                if let Some(value) = frozen_value {
                    *value += 10;
                }
                match (actual.entry(query, false), frozen.entry(query, false)) {
                    (Entry::Occupied(left), frozen_v8::Entry::Occupied(right)) => {
                        assert_eq!(left.get(), right.get());
                        assert_eq!(left.insert(100 + step as u32), right.insert(100 + step as u32));
                    }
                    (Entry::Vacant(left), frozen_v8::Entry::Vacant(right)) => {
                        left.insert(100 + step as u32);
                        right.insert(100 + step as u32);
                    }
                    _ => panic!("case-insensitive entry differs from frozen map"),
                }
                assert_eq!(query.avm1_property_index_hint(), Some(hint));
                assert_eq!(snapshot(&actual), frozen_snapshot(&frozen));
                assert_eq!(actual.remove_avm(query, false), frozen.remove_avm(query, false));
                assert_eq!(query.avm1_property_index_hint(), Some(hint));
                assert_eq!(snapshot(&actual), frozen_snapshot(&frozen));
            }
        }
        Ok(())
    });
}

#[test]
fn slot_hint_borrowed_wstr_operations_do_not_consume_or_rewrite_the_hint() {
    with_avm(8, |activation, _| {
        let stored = owned(activation, "borrowed");
        let query = owned(activation, "borrowed");
        let mut map = PropertyMap::new();
        map.insert(stored, 1u32, true);
        query.cache_avm1_property_index(41);
        for case_sensitive in [false, true] {
            assert!(map.contains_key(query.as_wstr(), case_sensitive));
            assert_eq!(map.get(query.as_wstr(), case_sensitive), Some(&1));
            *map.get_mut(query.as_wstr(), case_sensitive).expect("borrowed key exists") = 2;
            assert_eq!(query.avm1_property_index_hint(), Some(41));
            assert_eq!(map.remove(query.as_wstr(), case_sensitive), Some(2));
            assert_eq!(query.avm1_property_index_hint(), Some(41));
            map.insert(stored, 1, true);
        }
        assert_eq!(map.get_avm(query, true), Some(&1));
        assert_eq!(query.avm1_property_index_hint(), Some(0));
        Ok(())
    });
}

#[test]
fn slot_hint_range_aliases_append_and_equal_widths_keep_range_local_hints() {
    with_avm(8, |activation, _| {
        let mut buffer = WString::with_capacity(64, false);
        buffer.push_str(WStr::from_units(b"SlotHint"));
        let owner = AvmString::new(activation.gc(), buffer);
        let alias = owner;
        let prefix = AvmString::substring(activation.gc(), owner, 0, 4);
        let suffix = AvmString::substring(activation.gc(), owner, 4, 8);
        for name in [owner, prefix, suffix] {
            assert_eq!(name.avm1_property_index_hint(), None);
        }
        owner.cache_avm1_property_index(4);
        prefix.cache_avm1_property_index(1);
        suffix.cache_avm1_property_index(2);
        assert_eq!(alias.avm1_property_index_hint(), Some(4));
        alias.cache_avm1_property_index(5);
        assert_eq!(owner.avm1_property_index_hint(), Some(5));
        assert_eq!(prefix.avm1_property_index_hint(), Some(1));
        assert_eq!(suffix.avm1_property_index_hint(), Some(2));
        let appended = AvmString::concat(activation.gc(), owner, owned(activation, "Tail"));
        assert!(appended.is_dependent(), "fixture must append within reserved storage");
        assert_eq!(appended.avm1_property_index_hint(), None);
        assert_eq!(owner.as_wstr(), WStr::from_units(b"SlotHint"));
        assert_eq!(prefix.as_wstr(), WStr::from_units(b"Slot"));
        assert_eq!(owner.avm1_property_index_hint(), Some(5));

        let wide_units: Vec<u16> = "SlotHint".encode_utf16().collect();
        let wide = AvmString::new(activation.gc(), WStr::from_units(&wide_units[..]));
        let static_name = AvmString::new_ascii_static(activation.gc(), b"SlotHint");
        let equal_slice = AvmString::substring(activation.gc(), appended, 0, 8);
        let atom: AvmString<'_> = activation.context.strings.intern(equal_slice).into();
        let mut map = PropertyMap::new();
        map.insert(prefix, 1u32, true);
        map.insert(owner, 2, true);
        map.insert(appended, 3, true);
        for query in [wide, static_name, equal_slice, atom] {
            query.cache_avm1_property_index(0);
            assert_eq!(map.get_avm(query, true), Some(&2));
            assert_eq!(query.avm1_property_index_hint(), Some(1));
        }
        assert_eq!(map.get_avm(prefix, true), Some(&1));
        assert_eq!(map.get_avm(appended, true), Some(&3));
        Ok(())
    });
}

#[test]
fn slot_hint_zero_and_checked_u32_encoding_never_truncate_indices() {
    with_avm(8, |activation, _| {
        let name = owned(activation, "bounded-index");
        assert_eq!(name.avm1_property_index_hint(), None);
        name.cache_avm1_property_index(0);
        assert_eq!(name.avm1_property_index_hint(), Some(0));
        let largest = (u32::MAX - 1) as usize;
        name.cache_avm1_property_index(largest);
        assert_eq!(name.avm1_property_index_hint(), Some(largest));
        name.cache_avm1_property_index(u32::MAX as usize);
        assert_eq!(name.avm1_property_index_hint(), Some(largest));
        name.cache_avm1_property_index(usize::MAX);
        assert_eq!(name.avm1_property_index_hint(), Some(largest));
        let mut map = PropertyMap::new();
        map.insert(name, 7u32, true);
        assert_eq!(map.get_avm(name, true), Some(&7));
        assert_eq!(name.avm1_property_index_hint(), Some(0));
        Ok(())
    });
}

fn function<'gc>(activation: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&activation.context.strings, None, None)
}

fn increment<'gc>(activation: &mut Activation<'_, 'gc>, counter: &str) -> f64 {
    let global = activation.global_object();
    let name = owned(activation, counter);
    let old = match global.get_data(name, activation) {
        Some(Value::Number(value)) => value,
        _ => 0.0,
    };
    global.define_value(activation.gc(), name, (old + 1.0).into(), Attribute::empty());
    old + 1.0
}

fn getter<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    Ok(increment(activation, "slotHintGetterCalls").into())
}

fn watcher<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    increment(activation, "slotHintWatcherCalls");
    Ok(args[2])
}

#[test]
fn slot_hint_actual_avm_warm_slot_reobserves_virtual_descriptor_and_new_watcher() {
    with_avm(8, |activation, _| {
        let object = Object::new_without_proto(activation.gc());
        let preceding = owned(activation, "slotHintPreceding");
        let name = owned(activation, "slotHintVirtual");
        object.define_value(activation.gc(), preceding, 50.0.into(), Attribute::empty());
        object.define_value(activation.gc(), name, 10.0.into(), Attribute::empty());
        assert_eq!(object.get(name, activation)?, 10.0.into());
        assert!(name.avm1_property_index_hint().is_some());
        assert!(object.delete(activation, preceding));
        assert_eq!(object.get(name, activation)?, 10.0.into());

        object.add_property(activation.gc(), name, function(activation, getter), None, Attribute::empty());
        assert_eq!(object.get(name, activation)?, 1.0.into());
        assert_eq!(object.get(name, activation)?, 2.0.into());
        object.define_value(activation.gc(), name, 99.0.into(), Attribute::empty());
        assert_eq!(object.get(name, activation)?, 99.0.into());
        object.set(name, 100.0, activation)?;
        let watch_callback = function(activation, watcher);
        object.watch(activation, name, watch_callback, Value::Undefined);
        object.set(name, 101.0, activation)?;
        assert_eq!(object.get(name, activation)?, 101.0.into());
        assert!(object.unwatch(activation, name));
        object.set(name, 102.0, activation)?;
        assert_eq!(object.get(name, activation)?, 102.0.into());
        object.set_attributes(activation.gc(), Some(name), Attribute::READ_ONLY, Attribute::empty());
        object.set(name, 103.0, activation)?;
        assert_eq!(object.get(name, activation)?, 102.0.into());
        let global = activation.global_object();
        assert_eq!(global.get_data(owned(activation, "slotHintGetterCalls"), activation), Some(2.0.into()));
        assert_eq!(global.get_data(owned(activation, "slotHintWatcherCalls"), activation), Some(1.0.into()));
        Ok(())
    });
}
