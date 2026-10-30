//! Frozen v14 prototype lookup. Only the function visibility and imports differ.
//! This keeps the old raw own-descriptor gate and original native/getter reads;
//! it never dispatches through the candidate boxhead_lookup_property helper.

use crate::avm1::object::{BoxheadOwnProperty, Object, find_resolve_method};
use crate::avm1::{Activation, Error, Value};
use crate::string::AvmString;
use ruffle_macros::istr;

pub(super) fn search_prototype<'gc>(
    mut proto: Value<'gc>,
    name: AvmString<'gc>,
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    call_resolve_fn: bool,
) -> Result<Option<(Value<'gc>, u8)>, Error<'gc>> {
    let mut depth = 0;
    let orig_proto = proto;

    while let Value::Object(p) = proto {
        if depth == 255 {
            return Err(Error::PrototypeRecursionLimit);
        }

        match p.boxhead_own_property(name, activation) {
            BoxheadOwnProperty::Stored(value) => return Ok(Some((value, depth))),
            BoxheadOwnProperty::Missing => {},
            BoxheadOwnProperty::Special => {
                // Virtual descriptors and nonordinary native objects retain
                // the exact original getter/fallback sequence, including its
                // error handling and a fresh lookup after a callback.
                if let Some(result) = p.call_getter(name, this.into(), activation).transpose() {
                    match result {
                        Err(Error::PropertyRecursionLimit) => {
                            // Flash falls back to local resolution for compatibility
                            // with SWF<7.
                        }
                        // TODO Should we propagate all errors here?
                        Err(e @ Error::ThrownValue(_)) => return Err(e),
                        Err(e @ Error::FunctionRecursionLimit(_)) => return Err(e),
                        _ => {
                            let value = result.unwrap_or(Value::Undefined);
                            return Ok(Some((value, depth)));
                        }
                    };
                }

                if let Some(value) = p.get_local_stored(name, activation) {
                    return Ok(Some((value, depth)));
                }
            }
        }

        proto = p.proto(activation);
        depth += 1;
    }

    if call_resolve_fn && let Some(resolve) = find_resolve_method(orig_proto, activation)? {
        let result = resolve.call(istr!("__resolve"), activation, this.into(), &[name.into()])?;
        return Ok(Some((result, 0)));
    }

    Ok(None)
}
