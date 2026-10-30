//! Independent table and actual AVM1 fixtures for managed-name equality.
//! The frozen module is the complete prior PropertyMap body. It keeps its
//! borrowed-WStr equality queries and does not call either new Equivalent impl.

use super::*;
use crate::avm1::activation::Activation;
use crate::avm1::error::Error;
use crate::avm1::function::{FunctionObject, NativeFunction};
use crate::avm1::property::Attribute;
use crate::avm1::test_utils::with_avm;
use crate::avm1::{Object, Value};
use crate::string::WString;
use ruffle_macros::istr;

#[path = "frozen_v8.rs"]
mod frozen_v8;

fn owned<'gc>(activation: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> {
    AvmString::new_utf8(activation.gc(), value)
}

fn interned<'gc>(activation: &mut Activation<'_, 'gc>, value: &str) -> AvmString<'gc> {
    let value = owned(activation, value);
    activation.context.strings.intern(value).into()
}

fn compare<'gc>(
    actual: &PropertyMap<'gc, u32>,
    frozen: &frozen_v8::PropertyMap<'gc, u32>,
    queries: &[AvmString<'gc>],
) {
    let actual_order: Vec<_> = actual.iter()
        .map(|(name, value)| (name.iter().collect::<Vec<u16>>(), *value)).collect();
    let frozen_order: Vec<_> = frozen.iter()
        .map(|(name, value)| (name.iter().collect::<Vec<u16>>(), *value)).collect();
    assert_eq!(actual_order, frozen_order);
    for index in 0..=frozen_order.len() {
        assert_eq!(actual.get_index(index), frozen.get_index(index));
    }
    for &query in queries {
        for case_sensitive in [true, false] {
            // The old managed query explicitly drops identity before equality.
            let expected = frozen.get_avm(query, case_sensitive);
            assert_eq!(actual.get_avm(query, case_sensitive), expected);
            assert_eq!(actual.get(query.as_wstr(), case_sensitive), expected);
            assert_eq!(actual.contains_key_avm(query, case_sensitive), expected.is_some());
            assert_eq!(actual.contains_key(query.as_wstr(), case_sensitive), expected.is_some());
        }
    }
}

fn insert_pair<'gc>(
    actual: &mut PropertyMap<'gc, u32>,
    frozen: &mut frozen_v8::PropertyMap<'gc, u32>,
    name: AvmString<'gc>,
    value: u32,
    case_sensitive: bool,
) {
    assert_eq!(actual.insert(name, value, case_sensitive), frozen.insert(name, value, case_sensitive));
}

#[test]
fn property_equality_owned_identity_and_equal_allocations_match_frozen_queries() {
    with_avm(8, |activation, _| {
        let names: Vec<_> = ["", "mTick", "mTickSuffix", "mThing_1", "mThing_11", "__proto__"]
            .iter().map(|text| owned(activation, text)).collect();
        let mut queries = names.clone();
        for name in &names {
            let independent = AvmString::new(activation.gc(), name.as_wstr());
            assert!(independent.as_interned().is_none());
            queries.push(independent);
        }
        queries.push(owned(activation, "missing"));
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        for (index, &name) in names.iter().enumerate() {
            insert_pair(&mut actual, &mut frozen, name, index as u32, true);
        }
        compare(&actual, &frozen, &queries);
        for (index, &query) in queries[..names.len() * 2].iter().enumerate() {
            insert_pair(&mut actual, &mut frozen, query, 100 + index as u32, true);
        }
        compare(&actual, &frozen, &queries);
        Ok(())
    });
}

#[test]
fn property_equality_interned_names_keep_sensitive_and_folded_collision_choices() {
    with_avm(8, |activation, _| {
        let names: Vec<_> = ["Health", "health", "HEALTH", "hEaLtH", "Other", ""]
            .iter().map(|text| interned(activation, text)).collect();
        let equal = interned(activation, "Health");
        assert!(AvmString::ptr_eq(&names[0], &equal));
        assert!(!AvmString::ptr_eq(&names[0], &names[1]));
        assert!(names.iter().all(|name| name.as_interned().is_some()));
        let mut queries = names.clone();
        for &name in &names { queries.push(AvmString::new(activation.gc(), name.as_wstr())); }
        queries.push(interned(activation, "Missing"));
        for reverse in [false, true] {
            let mut actual = PropertyMap::new();
            let mut frozen = frozen_v8::PropertyMap::new();
            let indices: Vec<_> = if reverse { (0..names.len()).rev().collect() } else { (0..names.len()).collect() };
            for index in indices { insert_pair(&mut actual, &mut frozen, names[index], index as u32, true); }
            compare(&actual, &frozen, &queries);
            for (index, &query) in queries.iter().enumerate() {
                insert_pair(&mut actual, &mut frozen, query, 200 + index as u32, false);
                compare(&actual, &frozen, &queries);
            }
        }
        Ok(())
    });
}

#[test]
fn property_equality_utf16_widths_and_dependent_ranges_keep_exact_contents() {
    with_avm(8, |activation, _| {
        let bytes: [&[u8]; 5] = [b"", b"A\0Z", &[0xc0, 0xff, 0], b"__proto__", b"123"];
        let mut names = Vec::new();
        let mut queries = Vec::new();
        for bytes in bytes {
            let narrow = AvmString::new(activation.gc(), WStr::from_units(bytes));
            let wide: Vec<_> = bytes.iter().map(|byte| u16::from(*byte)).collect();
            let wide = AvmString::new(activation.gc(), WStr::from_units(&wide[..]));
            names.push(narrow);
            queries.extend([narrow, wide]);
        }
        let units: [&[u16]; 6] = [
            &[0xd800], &[0xdc00], &[0xd800, 0xdc00], &[0x03a3, 0], &[0x03c3, 0], &[0xffff, 0, 65],
        ];
        for units in units {
            let value = AvmString::new(activation.gc(), WStr::from_units(units));
            let mut parent_units = vec![0x58];
            parent_units.extend_from_slice(units);
            parent_units.push(0x59);
            let parent = AvmString::new(activation.gc(), WStr::from_units(&parent_units[..]));
            let slice = AvmString::substring(activation.gc(), parent, 1, 1 + units.len());
            let atom: AvmString<'_> = activation.context.strings.intern(slice).into();
            names.push(value);
            queries.extend([value, parent, slice, atom]);
        }
        let mut capacity = WString::with_capacity(64, false);
        capacity.push_str(WStr::from_units(b"Health"));
        let original = AvmString::new(activation.gc(), capacity);
        let suffix = owned(activation, "More");
        let appended = AvmString::concat(activation.gc(), original, suffix);
        assert!(appended.is_dependent());
        names.push(original);
        queries.extend([original, appended, AvmString::substring(activation.gc(), appended, 0, 6)]);
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        for (index, &name) in names.iter().enumerate() { insert_pair(&mut actual, &mut frozen, name, index as u32, true); }
        compare(&actual, &frozen, &queries);
        assert_eq!(actual.get_avm(appended, true), None);
        Ok(())
    });
}

#[test]
fn property_equality_interning_after_insertion_does_not_change_membership() {
    with_avm(8, |activation, _| {
        let original = owned(activation, "AfterInsert");
        let different = owned(activation, "afterinsert");
        let fresh_equal = owned(activation, "AfterInsert");
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        insert_pair(&mut actual, &mut frozen, original, 1, true);
        insert_pair(&mut actual, &mut frozen, different, 2, true);
        compare(&actual, &frozen, &[original, different, fresh_equal]);
        let atom: AvmString<'_> = activation.context.strings.intern(original).into();
        let other_atom: AvmString<'_> = activation.context.strings.intern(different).into();
        let same_atom: AvmString<'_> = activation.context.strings.intern(fresh_equal).into();
        assert!(original.as_interned().is_some());
        assert!(AvmString::ptr_eq(&atom, &same_atom));
        compare(&actual, &frozen, &[atom, same_atom, other_atom, fresh_equal]);
        assert_eq!(actual.remove_avm(atom, true), frozen.remove_avm(atom, true));
        compare(&actual, &frozen, &[atom, same_atom, other_atom, fresh_equal]);
        insert_pair(&mut actual, &mut frozen, fresh_equal, 3, true);
        compare(&actual, &frozen, &[atom, same_atom, other_atom, fresh_equal]);
        Ok(())
    });
}

#[test]
fn property_equality_mixed_mutations_clone_entries_and_order_match_frozen_map() {
    with_avm(8, |activation, _| {
        let mut names = Vec::new();
        for index in 0..48 {
            let upper = interned(activation, &format!("Field{index}"));
            let lower = interned(activation, &format!("field{index}"));
            names.extend([upper, lower, AvmString::new(activation.gc(), upper.as_wstr())]);
        }
        let mut actual = PropertyMap::new();
        let mut frozen = frozen_v8::PropertyMap::new();
        for (index, &name) in names.iter().enumerate() { insert_pair(&mut actual, &mut frozen, name, index as u32, true); }
        for step in 0..384usize {
            let query = names[(step * 37 + 11) % names.len()];
            let sensitive = step % 3 != 0;
            match step % 6 {
                0 => insert_pair(&mut actual, &mut frozen, query, step as u32, sensitive),
                1 => assert_eq!(actual.remove_avm(query, sensitive), frozen.remove_avm(query, sensitive)),
                2 => {
                    let left = actual.get_mut_avm(query, sensitive);
                    let right = frozen.get_mut_avm(query, sensitive);
                    assert_eq!(left.as_deref(), right.as_deref());
                    if let Some(value) = left { *value += 1; }
                    if let Some(value) = right { *value += 1; }
                }
                3 => match (actual.entry(query, sensitive), frozen.entry(query, sensitive)) {
                    (Entry::Occupied(mut left), frozen_v8::Entry::Occupied(mut right)) => {
                        assert_eq!(left.get(), right.get());
                        assert_eq!(left.remove_entry(), right.remove_entry());
                    }
                    (Entry::Vacant(left), frozen_v8::Entry::Vacant(right)) => {
                        left.insert(step as u32); right.insert(step as u32);
                    }
                    _ => panic!("entry occupancy differs from frozen table"),
                },
                4 => assert_eq!(actual.remove(query.as_wstr(), sensitive), frozen.remove(query.as_wstr(), sensitive)),
                _ => {
                    let mut left = actual.clone();
                    let mut right = frozen.clone();
                    for (_, value) in left.iter_mut() { *value += 17; }
                    for (_, value) in right.iter_mut() { *value += 17; }
                    compare(&left, &right, &names);
                    compare(&actual, &frozen, &names);
                }
            }
            if step % 23 == 0 { compare(&actual, &frozen, &names); }
        }
        compare(&actual, &frozen, &names);
        Ok(())
    });
}

#[test]
fn property_equality_actual_swf6_and_7_reads_reobserve_own_and_prototype_slots() {
    for version in [6, 7] {
        with_avm(version, |activation, _| {
            let prototype = Object::new_without_proto(activation.gc());
            let child = Object::new(&activation.context.strings, Some(prototype));
            let name = interned(activation, "FreshSlot");
            let upper = interned(activation, "FRESHSLOT");
            assert_eq!(child.get(name, activation)?, Value::Undefined);
            prototype.define_value(activation.gc(), name, 1.0.into(), Attribute::empty());
            assert_eq!(child.get(name, activation)?, 1.0.into());
            assert_eq!(child.get(upper, activation)?, if version < 7 { 1.0.into() } else { Value::Undefined });
            child.set(name, 2.0, activation)?;
            assert_eq!(child.get(name, activation)?, 2.0.into());
            assert!(child.delete(activation, name));
            assert_eq!(child.get(name, activation)?, 1.0.into());
            prototype.set(name, 3.0, activation)?;
            assert_eq!(child.get(name, activation)?, 3.0.into());
            assert!(prototype.delete(activation, name));
            assert_eq!(child.get(name, activation)?, Value::Undefined);
            let replacement = Object::new_without_proto(activation.gc());
            replacement.define_value(activation.gc(), name, 4.0.into(), Attribute::empty());
            child.set(istr!("__proto__"), replacement, activation)?;
            assert_eq!(child.get(name, activation)?, 4.0.into());
            Ok(())
        });
    }
}

fn function<'gc>(activation: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> {
    FunctionObject::native(callback).build(&activation.context.strings, None, None)
}

fn increment<'gc>(activation: &mut Activation<'_, 'gc>, name: &str) -> f64 {
    let global = activation.global_object();
    let name = owned(activation, name);
    let old = match global.get_data(name, activation) { Some(Value::Number(value)) => value, _ => 0.0 };
    global.define_value(activation.gc(), name, (old + 1.0).into(), Attribute::empty());
    old + 1.0
}

fn getter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, _args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    Ok(increment(activation, "equalityGets").into())
}

fn setter<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(activation, "equalitySets");
    let global = activation.global_object();
    global.define_value(activation.gc(), owned(activation, "equalityLastSet"), args[0], Attribute::empty());
    Ok(Value::Undefined)
}

fn watcher<'gc>(activation: &mut Activation<'_, 'gc>, _this: Object<'gc>, args: &[Value<'gc>]) -> Result<Value<'gc>, Error<'gc>> {
    increment(activation, "equalityWatches");
    Ok(args[2])
}

#[test]
fn property_equality_actual_interned_reads_keep_getter_setter_and_watcher_calls() {
    for version in [6, 7] {
        with_avm(version, |activation, _| {
            let object = Object::new_without_proto(activation.gc());
            let name = interned(activation, "VirtualSlot");
            let stored = interned(activation, "StoredSlot");
            object.add_property(activation.gc(), name, function(activation, getter), Some(function(activation, setter)), Attribute::empty());
            let equal = AvmString::new(activation.gc(), name.as_wstr());
            for (index, query) in [name, equal, name, equal].into_iter().enumerate() {
                assert_eq!(object.get(query, activation)?, Value::Number((index + 1) as f64));
            }
            object.set(name, 41.0, activation)?;
            object.set(equal, 42.0, activation)?;
            object.define_value(activation.gc(), stored, 0.0.into(), Attribute::empty());
            let callback = function(activation, watcher);
            object.watch(activation, stored, callback, Value::Undefined);
            for value in 1..=3 {
                object.set(stored, f64::from(value), activation)?;
                assert_eq!(object.get(stored, activation)?, Value::Number(f64::from(value)));
            }
            let global = activation.global_object();
            assert_eq!(global.get_data(owned(activation, "equalityGets"), activation), Some(4.0.into()));
            assert_eq!(global.get_data(owned(activation, "equalitySets"), activation), Some(2.0.into()));
            assert_eq!(global.get_data(owned(activation, "equalityLastSet"), activation), Some(42.0.into()));
            assert_eq!(global.get_data(owned(activation, "equalityWatches"), activation), Some(3.0.into()));
            assert!(object.unwatch(activation, stored));
            object.set(stored, 4.0, activation)?;
            assert_eq!(global.get_data(owned(activation, "equalityWatches"), activation), Some(3.0.into()));
            Ok(())
        });
    }
}

#[test]
fn property_equality_actual_case_collisions_and_readonly_flags_match_frozen_table() {
    for version in [6, 7] {
        with_avm(version, |activation, _| {
            let object = Object::new_without_proto(activation.gc());
            let names = [interned(activation, "Thing"), interned(activation, "thing"), interned(activation, "THING")];
            let mut frozen = frozen_v8::PropertyMap::new();
            for (index, &name) in names[..2].iter().enumerate() {
                object.define_value(activation.gc(), name, Value::Number(index as f64), Attribute::empty());
                frozen.insert(name, index as u32, true);
            }
            for &name in &names {
                let expected = frozen.get_avm(name, version >= 7)
                    .map_or(Value::Undefined, |value| Value::Number(f64::from(*value)));
                assert_eq!(object.get(name, activation)?, expected);
            }
            let protected = interned(activation, "Protected");
            object.define_value(activation.gc(), protected, 8.0.into(), Attribute::READ_ONLY | Attribute::DONT_DELETE | Attribute::DONT_ENUM);
            object.set(protected, 9.0, activation)?;
            assert_eq!(object.get(protected, activation)?, 8.0.into());
            assert!(!object.delete(activation, protected));
            assert!(!object.get_keys(activation, false).contains(&protected));
            object.set_attributes(activation.gc(), Some(protected), Attribute::empty(), Attribute::READ_ONLY | Attribute::DONT_DELETE | Attribute::DONT_ENUM);
            object.set(protected, 10.0, activation)?;
            assert_eq!(object.get(protected, activation)?, 10.0.into());
            assert!(object.get_keys(activation, false).contains(&protected));
            assert!(object.delete(activation, protected));
            Ok(())
        });
    }
}
