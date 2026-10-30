use super::*;
use crate::avm1::function::{ExecutionReason, FunctionObject, NativeFunction};
use crate::avm1::test_utils::with_avm;
use std::time::Duration;

fn name<'gc>(a: &Activation<'_, 'gc>, value: &str) -> AvmString<'gc> { AvmString::new_utf8(a.gc(),value) }
fn object<'gc>(a: &Activation<'_, 'gc>) -> Object<'gc> { Object::new(&a.context.strings,Some(a.prototypes().object)) }
fn define<'gc>(a: &Activation<'_, 'gc>, o: Object<'gc>, k: &str, v: Value<'gc>, f: Attribute) { o.define_value(a.gc(),name(a,k),v,f); }
fn stored<'gc>(a: &mut Activation<'_, 'gc>, o: Object<'gc>, k: &str) -> Value<'gc> { raw(o,k,a).unwrap_or(Value::Undefined) }
fn function<'gc>(a: &Activation<'_, 'gc>, callback: NativeFunction) -> Object<'gc> { FunctionObject::native(callback).build(&a.context.strings,None,None) }
fn yes<'gc>(_a: &mut Activation<'_, 'gc>, _o: Object<'gc>, _v: &[Value<'gc>]) -> Result<Value<'gc>,Error<'gc>> { Ok(true.into()) }
fn no<'gc>(_a: &mut Activation<'_, 'gc>, _o: Object<'gc>, _v: &[Value<'gc>]) -> Result<Value<'gc>,Error<'gc>> { Ok(false.into()) }
fn must_not_run<'gc>(_a: &mut Activation<'_, 'gc>, _o: Object<'gc>, _v: &[Value<'gc>]) -> Result<Value<'gc>,Error<'gc>> { panic!("checkpoint executed a getter, watcher or setter") }

fn anchors<'gc>(a: &Activation<'_, 'gc>, rows: &[(&str,Value<'gc>,bool)]) -> Object<'gc> {
    let array=Object::new_without_proto(a.gc()); array.set_native(a.gc(),NativeObject::Array(()));
    define(a,array,"length",(rows.len() as f64).into(),Attribute::DONT_ENUM | Attribute::DONT_DELETE);
    for (i,(id,value,deep)) in rows.iter().enumerate() {
        let row=Object::new_without_proto(a.gc());
        define(a,row,"id",name(a,id).into(),Attribute::empty());
        define(a,row,"value",*value,Attribute::empty());
        define(a,row,"deep",(*deep).into(),Attribute::empty());
        define(a,array,&i.to_string(),row.into(),Attribute::empty());
    }
    array
}

fn invoke<'gc>(a: &mut Activation<'_, 'gc>, operation: &str, args: &[Value<'gc>]) -> Result<Value<'gc>,Error<'gc>> {
    let mut values=vec![name(a,operation).into()]; values.extend(args);
    let global=a.global_object(); call(a,global,&values)
}

fn wire<'gc>(a: &mut Activation<'_, 'gc>, root: Value<'gc>, registry: Object<'gc>) -> AvmString<'gc> {
    let Value::String(wire)=invoke(a,"export",&[root,registry.into()]).unwrap() else { panic!("export string"); }; wire
}

#[test]
fn native_graph_capability_is_hidden_readonly_and_registered() {
    with_avm(8,|a,_| {
        let global=a.global_object(); let key=name(a,"boxheadNativeGraphV1");
        let before=global.get(key,a)?; assert!(matches!(before,Value::Object(o) if o.as_function().is_some()));
        assert!(!global.get_keys(a,false).contains(&key)); global.set(key,Value::Null,a)?; assert_eq!(before,global.get(key,a)?);
        let Value::Object(c)=invoke(a,"capability",&[])? else { panic!("capability"); };
        assert_eq!(stored(a,c,"version"),1.0.into()); assert_eq!(stored(a,c,"contract"),name(a,FORMAT).into());
        assert_eq!(stored(a,c,"bitmapData"),true.into()); Ok(())
    });
}

#[test]
fn native_graph_preserves_cycles_aliases_holes_hidden_flags_and_order() {
    with_avm(8,|a,_| {
        let registry=anchors(a,&[("Object",a.prototypes().object.into(),false),("Array",a.prototypes().array.into(),false)]);
        let root=object(a); let array=Object::new_with_native(&a.context.strings,Some(a.prototypes().array),NativeObject::Array(()));
        define(a,array,"length",7.0.into(),Attribute::DONT_ENUM | Attribute::DONT_DELETE);
        define(a,array,"2",root.into(),Attribute::empty()); define(a,array,"5",Value::Undefined,Attribute::empty());
        define(a,root,"earlier",17.0.into(),Attribute::empty()); define(a,root,"hidden",41.0.into(),Attribute::DONT_ENUM | Attribute::READ_ONLY | Attribute::VERSION_10);
        define(a,root,"a",array.into(),Attribute::empty()); define(a,root,"b",array.into(),Attribute::empty()); define(a,root,"self",root.into(),Attribute::empty());
        let before=wire(a,root.into(),registry); let Value::Object(restored)=invoke(a,"import",&[before.into(),registry.into()])? else { panic!("root"); };
        assert!(!Object::ptr_eq(root,restored)); assert_eq!(stored(a,restored,"self"),restored.into());
        assert_eq!(stored(a,restored,"a"),stored(a,restored,"b"));
        let Value::Object(rarray)=stored(a,restored,"a") else { panic!("array"); };
        assert!(matches!(rarray.native(),NativeObject::Array(_))); assert_eq!(stored(a,rarray,"length"),7.0.into());
        assert!(raw(rarray,"0",a).is_none()); assert_eq!(stored(a,rarray,"2"),restored.into()); assert!(raw(rarray,"5",a).is_some());
        assert_eq!(wire(a,restored.into(),registry),before);
        let hidden=restored.boxhead_graph_properties().unwrap().into_iter().find(|(k,_,_)|k.eq_with_case(b"hidden",true)).unwrap();
        assert_eq!(hidden.2.bits(),(Attribute::DONT_ENUM | Attribute::READ_ONLY | Attribute::VERSION_10).bits());
        assert_eq!(root.get_keys(a,false),restored.get_keys(a,false)); Ok(())
    });
}

#[test]
fn native_graph_preserves_every_number_bit_and_utf16_units() {
    with_avm(8,|a,_| {
        let registry=anchors(a,&[("Object",a.prototypes().object.into(),false)]); let root=object(a);
        let bits=[0,0x8000000000000000,1,0x0010000000000000,0x7fefffffffffffff,0x7ff0000000000000,0xfff0000000000000,0x7ff8000000001234,0x3fb999999999999a];
        for (i,v) in bits.iter().enumerate(){define(a,root,&i.to_string(),Value::Number(f64::from_bits(*v)),Attribute::empty());}
        let utf16=[0,0xd800,65,0xdc00,0xffff]; define(a,root,"text",AvmString::new(a.gc(),WStr::from_units(&utf16[..])).into(),Attribute::empty());
        let packet=wire(a,root.into(),registry); let Value::Object(restored)=invoke(a,"import",&[packet.into(),registry.into()])? else {panic!("root")};
        for (i,bits) in bits.iter().enumerate(){let Value::Number(v)=stored(a,restored,&i.to_string()) else{panic!("number")}; assert_eq!(v.to_bits(),*bits);}
        let Value::String(text)=stored(a,restored,"text") else{panic!("text")}; assert_eq!(text.iter().collect::<Vec<_>>(),utf16); Ok(())
    });
}

#[test]
fn native_graph_rebinds_prototypes_and_functions_to_receiving_registry() {
    with_avm(8,|a,_| {
        let host_proto=object(a); let guest_proto=object(a); let host_method=function(a,yes); let guest_method=function(a,no);
        let host=anchors(a,&[("Thing.prototype",host_proto.into(),false),("Thing.Process",host_method.into(),false)]);
        let guest=anchors(a,&[("Thing.prototype",guest_proto.into(),false),("Thing.Process",guest_method.into(),false)]);
        let root=Object::new(&a.context.strings,Some(host_proto)); define(a,root,"Process",host_method.into(),Attribute::empty());
        let packet=wire(a,root.into(),host); let Value::Object(restored)=invoke(a,"import",&[packet.into(),guest.into()])? else {panic!("root")};
        assert_eq!(stored(a,restored,"__proto__"),guest_proto.into()); assert_eq!(stored(a,restored,"Process"),guest_method.into());
        assert_eq!(restored.call_method(name(a,"Process"),&[],a,ExecutionReason::FunctionCall)?,false.into());
        assert_eq!(wire(a,restored.into(),guest),packet); Ok(())
    });
}

#[test]
fn native_graph_rebinds_both_movieclip_value_kinds_to_one_receiving_stage_object() {
    with_avm(8,|a,_| {
        let host_clip=a.base_clip().object1().expect("test root has an AVM1 stage object");
        let host_reference=MovieClipReference::try_from_stage_object(a,host_clip).expect("test root is a MovieClip");
        let method=name(a,"createEmptyMovieClip"); let child_name=name(a,"checkpointTarget");
        let target=host_clip.call_method(method,&[child_name.into(),1.0.into()],a,ExecutionReason::FunctionCall)?;
        let target_clip=target.as_object(a).expect("createEmptyMovieClip returned a stage object");
        assert!(!Object::ptr_eq(host_clip,target_clip));
        let host=anchors(a,&[("Object",a.prototypes().object.into(),false),("clip",Value::MovieClip(host_reference),false)]);
        let guest=anchors(a,&[("Object",a.prototypes().object.into(),false),("clip",target_clip.into(),false)]);
        let root=object(a); define(a,root,"direct",host_clip.into(),Attribute::empty());
        define(a,root,"reference",Value::MovieClip(host_reference),Attribute::empty());
        let packet=wire(a,root.into(),host);
        let Value::Object(restored)=invoke(a,"import",&[packet.into(),guest.into()])? else{panic!("root")};
        assert_eq!(stored(a,restored,"direct"),Value::Object(target_clip));
        let Value::MovieClip(reference)=stored(a,restored,"reference") else{panic!("MovieClip Value kind was lost")};
        assert!(Object::ptr_eq(reference.coerce_to_object(a).expect("restored reference resolves"),target_clip));
        assert_eq!(wire(a,restored.into(),guest),packet); Ok(())
    });
}

#[test]
fn native_graph_rejects_unbound_functions_native_objects_and_prototypes() {
    with_avm(8,|a,clip| {
        let registry=anchors(a,&[("Object",a.prototypes().object.into(),false)]); let root=object(a);
        define(a,root,"f",function(a,yes).into(),Attribute::empty()); assert!(invoke(a,"export",&[root.into(),registry.into()]).is_err());
        define(a,root,"f",clip.into(),Attribute::empty()); assert!(invoke(a,"export",&[root.into(),registry.into()]).is_err());
        let custom_proto=object(a); let root=Object::new(&a.context.strings,Some(custom_proto)); assert!(invoke(a,"export",&[root.into(),registry.into()]).is_err()); Ok(())
    });
}

#[test]
fn native_graph_rejects_virtual_properties_watchers_and_interfaces_without_callbacks() {
    with_avm(8,|a,_| {
        let registry=anchors(a,&[("Object",a.prototypes().object.into(),false)]); let callback=function(a,must_not_run);
        let root=object(a); root.add_property(a.gc(),name(a,"value"),callback,Some(callback),Attribute::empty());
        assert!(invoke(a,"export",&[root.into(),registry.into()]).is_err());
        let watched=object(a); let watched_key=name(a,"value"); watched.watch(a,watched_key,callback,Value::Undefined);
        assert!(invoke(a,"export",&[watched.into(),registry.into()]).is_err());
        let with_interface=object(a); with_interface.set_interfaces(a.gc(),vec![a.prototypes().object]);
        assert!(invoke(a,"export",&[with_interface.into(),registry.into()]).is_err()); Ok(())
    });
}

#[test]
fn native_graph_deep_assets_use_stable_key_paths_and_preserve_aliases() {
    with_avm(8,|a,_| {
        let host_asset=object(a); let host_child=object(a); let guest_asset=object(a); let guest_child=object(a);
        define(a,host_asset,"z",host_child.into(),Attribute::empty()); define(a,host_asset,"a",host_child.into(),Attribute::empty());
        define(a,guest_asset,"a",guest_child.into(),Attribute::empty()); define(a,guest_asset,"z",guest_child.into(),Attribute::empty());
        define(a,host_child,"cycle",host_asset.into(),Attribute::empty()); define(a,guest_child,"cycle",guest_asset.into(),Attribute::empty());
        let host=anchors(a,&[("Object",a.prototypes().object.into(),false),("asset",host_asset.into(),true)]);
        let guest=anchors(a,&[("Object",a.prototypes().object.into(),false),("asset",guest_asset.into(),true)]);
        let root=object(a); define(a,root,"frame",host_child.into(),Attribute::empty());
        let packet=wire(a,root.into(),host); let Value::Object(restored)=invoke(a,"import",&[packet.into(),guest.into()])? else{panic!("root")};
        assert_eq!(stored(a,restored,"frame"),guest_child.into()); assert_eq!(wire(a,restored.into(),guest),packet); Ok(())
    });
}

#[test]
fn native_graph_dynamic_bitmap_and_existing_target_copy_preserve_raw_alpha_pixels() {
    with_avm(8,|a,_| {
        let registry=anchors(a,&[("BitmapData",a.prototypes().bitmap_data.into(),false)]);
        let pixels=vec![Color::rgba(1,2,3,7),Color::rgba(0,0,0,0),Color::rgba(127,63,31,128),Color::rgba(255,254,253,255)];
        let bitmap=BitmapData::new_with_pixels(a.gc(),2,2,true,pixels.clone());
        let root=Object::new_with_native(&a.context.strings,Some(a.prototypes().bitmap_data),NativeObject::BitmapData(bitmap));
        let packet=wire(a,root.into(),registry); let Value::Object(restored)=invoke(a,"import",&[packet.into(),registry.into()])? else{panic!("bitmap")};
        let NativeObject::BitmapData(restored_pixels)=restored.native() else{panic!("native bitmap")};
        assert!(!bitmap.ptr_eq(restored_pixels)); assert_eq!(restored_pixels.sync(a.context.renderer).borrow().pixels(),pixels);
        let target=BitmapData::new(a.gc(),2,2,true,0); let target_object=Object::new_with_native(&a.context.strings,Some(a.prototypes().bitmap_data),NativeObject::BitmapData(target));
        assert_eq!(invoke(a,"bitmapCopy",&[target_object.into(),restored.into()])?,true.into());
        assert_eq!(target.sync(a.context.renderer).borrow().pixels(),pixels); assert_eq!(wire(a,restored.into(),registry),packet);
        let wrong=BitmapData::new(a.gc(),3,2,true,0); let wrong_object=Object::new_with_native(&a.context.strings,Some(a.prototypes().bitmap_data),NativeObject::BitmapData(wrong));
        assert!(invoke(a,"bitmapCopy",&[wrong_object.into(),restored.into()]).is_err()); assert!(wrong.sync(a.context.renderer).borrow().pixels().iter().all(|p|p.to_bgra_u32()==0)); Ok(())
    });
}

#[test]
fn native_graph_rejects_bad_references_duplicate_fields_and_trailing_data() {
    with_avm(8,|a,_| {
        let registry=anchors(a,&[]);
        let invalid=Graph{swf_version:8,root:Atom::Ref(4),nodes:vec![],fields:0};
        let bad=name(a,&pack(&invalid).unwrap()); assert!(invoke(a,"import",&[bad.into(),registry.into()]).is_err());
        let field=Field{name:vec![120],flags:0,value:Atom::Null};
        let duplicate=Graph{swf_version:8,root:Atom::Ref(0),nodes:vec![Node{kind:0,bitmap:None,fields:vec![field.clone(),field]}],fields:2};
        let bad=name(a,&pack(&duplicate).unwrap()); assert!(invoke(a,"import",&[bad.into(),registry.into()]).is_err());
        let valid=wire(a,Value::Number(1.0),registry); let trailing=name(a,&(valid.to_utf8_lossy().into_owned()+"00"));
        assert!(invoke(a,"import",&[trailing.into(),registry.into()]).is_err()); Ok(())
    });
}

#[test]
fn native_graph_requires_matching_anchor_kind_and_swf_version() {
    with_avm(8,|a,_| {
        let fn_value=function(a,yes); let from=anchors(a,&[("fn",fn_value.into(),false)]); let target=object(a);
        let wrong=anchors(a,&[("fn",target.into(),false)]); let packet=wire(a,fn_value.into(),from);
        assert!(invoke(a,"import",&[packet.into(),wrong.into()]).is_err()); assert!(target.own_properties().is_empty());
        let empty=anchors(a,&[]); let invalid=Graph{swf_version:7,root:Atom::Null,nodes:vec![],fields:0}; let packet=name(a,&pack(&invalid).unwrap());
        assert!(invoke(a,"import",&[packet.into(),empty.into()]).is_err()); Ok(())
    });
}

#[test]
fn native_graph_timeout_prevents_export_and_bitmap_commit() {
    with_avm(8,|a,_| {
        let registry=anchors(a,&[]); let previous=a.context.max_execution_duration; a.context.max_execution_duration=Duration::ZERO;
        assert!(invoke(a,"export",&[Value::Number(1.0),registry.into()]).is_err()); a.context.max_execution_duration=previous; Ok(())
    });
}

#[test]
fn native_graph_roundtrips_three_map14_scale_surfaces_above_old_budget() {
    with_avm(8, |a, _| {
        // Actual map14 has 58x47 cells of 32 pixels. These nominal original
        // floor/cover/decal-mask dimensions consume 33,497,088 raw bytes.
        // Add ordinary graph data so this fixture necessarily exceeds v3's
        // 32 MiB bound; no native surface is dropped or substituted by a hash.
        a.context.max_execution_duration = Duration::from_secs(120);
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("BitmapData", a.prototypes().bitmap_data.into(), false)]);
        let root = object(a);
        let (width, height) = (1856u32, 1504u32);
        let count = width as usize * height as usize;
        let mut originals = Vec::new();
        for (index, key) in ["floor", "cover", "decalMask"].iter().enumerate() {
            let pixels = (0..count).map(|i| {
                let alpha = if index == 0 { 255 } else { ((i + index * 17) & 255) as u8 };
                Color::rgba(alpha / 2, alpha / 3, alpha / 5, alpha)
            }).collect();
            let bitmap = BitmapData::new_with_pixels(a.gc(), width, height, index != 0, pixels);
            let value = Object::new_with_native(&a.context.strings, Some(a.prototypes().bitmap_data), NativeObject::BitmapData(bitmap));
            define(a, root, key, value.into(), Attribute::empty());
            originals.push((value, bitmap));
        }
        define(a, root, "floorAlias", originals[0].0.into(), Attribute::empty());
        let padding = vec![65u16; 65_536];
        define(a, root, "cellState", AvmString::new(a.gc(), WStr::from_units(padding.as_slice())).into(), Attribute::DONT_ENUM);
        assert_eq!(3 * count * 4, 33_497_088);
        assert!(3 * count * 4 + padding.len() * 2 > 32 * 1024 * 1024);
        let packet = wire(a, root.into(), registry);
        // Compressible representative geometry remains below the independent
        // application ASCII cap; the native decoded bound is a different unit.
        assert!(packet.len() < 16 * 1024 * 1024);
        let decoded = unpack(packet).unwrap();
        assert_eq!(decoded.nodes.iter().filter(|node| node.kind == 2).count(), 3);
        assert_eq!(decoded.nodes.iter().filter_map(|node| node.bitmap.as_ref()).map(|p| p.rgba.len() * 4).sum::<usize>(), 33_497_088);
        drop(decoded);
        let Value::Object(restored) = invoke(a, "import", &[packet.into(), registry.into()])? else { panic!("root"); };
        assert_eq!(stored(a, restored, "floorAlias"), stored(a, restored, "floor"));
        for (index, key) in ["floor", "cover", "decalMask"].iter().enumerate() {
            let Value::Object(value) = stored(a, restored, key) else { panic!("surface"); };
            let NativeObject::BitmapData(bitmap) = value.native() else { panic!("bitmap"); };
            assert!(!bitmap.ptr_eq(originals[index].1));
            assert_eq!((bitmap.width(), bitmap.height(), bitmap.transparency()), (width, height, index != 0));
            let restored_data = bitmap.sync(a.context.renderer);
            let original_data = originals[index].1.sync(a.context.renderer);
            assert_eq!(restored_data.borrow().pixels(), original_data.borrow().pixels());
        }
        assert_eq!(wire(a, restored.into(), registry), packet);
        Ok(())
    });
}

fn compressed_fixture(bytes: &[u8]) -> String {
    let mut compressor = ZlibEncoder::new(Vec::new(), Compression::fast());
    compressor.write_all(bytes).unwrap();
    let compressed = compressor.finish().unwrap();
    let mut text = String::with_capacity(PREFIX.len() + compressed.len() * 2);
    text.push_str(PREFIX);
    for value in compressed { text.push_str(&format!("{value:02x}")); }
    text
}

#[test]
fn native_graph_accepts_exact_128mib_decoded_packet_and_rejects_next_byte() {
    with_avm(8, |a, _| {
        assert_eq!(MAX_BYTES, 128 * 1024 * 1024);
        assert_eq!(MAX_WIRE, 2 * (32 * 1024 * 1024) + 1024);
        // Four legal bitmap shapes plus two data properties encode exactly
        // 128 MiB: 74 bytes of framing + 134,201,344 pixel bytes + 16,310
        // property bytes. Every bitmap retains the 8,388,608-pixel cap.
        let mut graph = Graph { swf_version: 8, root: Atom::Ref(0), fields: 2, nodes: vec![
            Node { kind: 2, bitmap: Some(Pixels { width: 4096, height: 2048, transparent: true,
                rgba: vec![[1, 2, 3, 255]; 4096 * 2048] }), fields: vec![
                Field { name: vec![112, 97, 100], flags: 0, value: Atom::String(vec![65; 8143]) },
                Field { name: vec![], flags: 0, value: Atom::Null },
            ] },
            Node { kind: 2, bitmap: Some(Pixels { width: 4096, height: 2048, transparent: false,
                rgba: vec![[4, 5, 6, 255]; 4096 * 2048] }), fields: vec![] },
            Node { kind: 2, bitmap: Some(Pixels { width: 4096, height: 2048, transparent: true,
                rgba: vec![[7, 8, 9, 255]; 4096 * 2048] }), fields: vec![] },
            Node { kind: 2, bitmap: Some(Pixels { width: 4096, height: 2047, transparent: false,
                rgba: vec![[10, 11, 12, 255]; 4096 * 2047] }), fields: vec![] },
        ] };
        let packet = pack(&graph).unwrap();
        let restored = unpack(name(a, &packet)).unwrap();
        assert_eq!(restored, graph);
        drop(restored);
        let Atom::String(padding) = &mut graph.nodes[0].fields[0].value else { panic!("padding"); };
        padding.push(65); // Two additional encoded bytes must fail at export.
        assert_eq!(pack(&graph).unwrap_err(), "encoded data size limit exceeded");
        drop(graph);
        let encoded: Vec<u8> = packet[PREFIX.len()..].as_bytes().chunks_exact(2)
            .map(|v| u8::from_str_radix(std::str::from_utf8(v).unwrap(), 16).unwrap()).collect();
        let mut decoded = Vec::new();
        ZlibDecoder::new(encoded.as_slice()).read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded.len(), MAX_BYTES);
        decoded.push(0); // Highly compressed MAX_BYTES+1 input is an inflate bomb.
        let oversized = compressed_fixture(&decoded);
        drop(decoded);
        assert!(oversized.len() < 4 * 1024 * 1024);
        assert_eq!(unpack(name(a, &oversized)).unwrap_err(), "graph exceeds size bound or has trailing compressed bytes");
        Ok(())
    });
}

#[test]
fn native_graph_export_rejects_sum_above_128mib_without_mutating_source() {
    with_avm(8, |a, _| {
        a.context.max_execution_duration = Duration::from_secs(120);
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("BitmapData", a.prototypes().bitmap_data.into(), false)]);
        let root = object(a);
        let mut bitmaps = Vec::new();
        // Each bitmap is individually legal. Together their 128 MiB of pixels
        // plus required graph properties exceed the aggregate decoded budget.
        for key in ["one", "two", "three", "four"] {
            let bitmap = BitmapData::new(a.gc(), 4096, 2048, true, 0xff123456);
            let value = Object::new_with_native(&a.context.strings, Some(a.prototypes().bitmap_data), NativeObject::BitmapData(bitmap));
            define(a, root, key, value.into(), Attribute::empty()); bitmaps.push(bitmap);
        }
        let before = root.boxhead_graph_properties().unwrap().into_iter()
            .map(|(key, value, flags)| (key, value, flags.bits())).collect::<Vec<_>>();
        let bindings = Anchors::read(registry.into(), a).unwrap();
        assert_eq!(export_graph(root.into(), &bindings, a).unwrap_err(), "graph data size limit exceeded");
        let after = root.boxhead_graph_properties().unwrap().into_iter()
            .map(|(key, value, flags)| (key, value, flags.bits())).collect::<Vec<_>>();
        assert_eq!(after, before);
        for bitmap in bitmaps {
            let data = bitmap.sync(a.context.renderer);
            assert!(data.borrow().pixels().iter().all(|p| p.to_bgra_u32() == 0xff123456));
        }
        Ok(())
    });
}

#[test]
fn native_graph_rejects_oversized_bitmap_and_count_headers_before_allocation() {
    with_avm(8, |a, _| {
        assert_eq!(MAX_PIXELS, 8_388_608); assert_eq!(MAX_NODES, 65_536); assert_eq!(MAX_FIELDS, 1_000_000);
        for (nodes, fields) in [(MAX_NODES + 1, 0), (0, MAX_FIELDS + 1)] {
            let mut w = Writer(Vec::new());
            w.0.extend(b"BHG\x01"); w.u8(8); w.u32(nodes as u32); w.u32(fields as u32); w.u8(1);
            let packet = compressed_fixture(&w.0);
            assert_eq!(unpack(name(a, &packet)).unwrap_err(), "graph counts exceed bounds");
        }
        let mut w = Writer(Vec::new());
        w.0.extend(b"BHG\x01"); w.u8(8); w.u32(1); w.u32(0); w.u8(6); w.u32(0);
        w.u8(2); w.u32((MAX_PIXELS + 1) as u32); w.u32(1); w.u8(1);
        // No claimed pixel body is supplied: the shape must be rejected before
        // attempting to read or allocate it, rather than as a truncation error.
        let packet = compressed_fixture(&w.0);
        assert_eq!(unpack(name(a, &packet)).unwrap_err(), "invalid graph BitmapData shape");
        let Value::Object(capability) = invoke(a, "capability", &[])? else { panic!("capability"); };
        assert_eq!(stored(a, capability, "maxBytes"), (128.0 * 1024.0 * 1024.0).into());
        assert_eq!(stored(a, capability, "maxNodes"), 65_536.0.into());
        assert_eq!(stored(a, capability, "maxFields"), 1_000_000.0.into());
        Ok(())
    });
}


#[test]
fn native_graph_roundtrips_map18_geometry_envelope_above_64mib() {
    with_avm(8, |a, _| {
        // Observed grid 87x87 and original Math.round(mArea/32) bound each
        // surface dimension below 2800. This conservative envelope plus
        // 20 MiB ordinary data is capacity evidence, not a real-game fixture.
        a.context.max_execution_duration = Duration::from_secs(120);
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("BitmapData", a.prototypes().bitmap_data.into(), false)]);
        let root = object(a);
        let (width, height) = (2800u32, 2800u32);
        let count = width as usize * height as usize;
        assert!(count <= MAX_PIXELS);
        let mut originals = Vec::new();
        for (index, key) in ["floor", "cover", "decalMask"].iter().enumerate() {
            let pixels = (0..count).map(|i| {
                let alpha = if index == 0 { 255 } else { ((i + index * 17) & 255) as u8 };
                Color::rgba(alpha / 2, alpha / 3, alpha / 5, alpha)
            }).collect();
            let bitmap = BitmapData::new_with_pixels(a.gc(), width, height, index != 0, pixels);
            let value = Object::new_with_native(&a.context.strings, Some(a.prototypes().bitmap_data), NativeObject::BitmapData(bitmap));
            define(a, root, key, value.into(), Attribute::empty());
            originals.push((value, bitmap));
        }
        define(a, root, "floorAlias", originals[0].0.into(), Attribute::empty());
        let padding = vec![65u16; MAX_STRING];
        let text = AvmString::new(a.gc(), WStr::from_units(padding.as_slice()));
        for i in 0..10 { define(a, root, &format!("cellState{i}"), text.into(), Attribute::DONT_ENUM); }
        assert_eq!(3 * count * 4, 94_080_000);
        assert!(3 * count * 4 > 64 * 1024 * 1024);
        assert!(3 * count * 4 + 10 * padding.len() * 2 < MAX_BYTES);
        let packet = wire(a, root.into(), registry);
        assert!(packet.len() < 16 * 1024 * 1024);
        let decoded = unpack(packet).unwrap();
        assert_eq!(decoded.nodes.iter().filter(|node| node.kind == 2).count(), 3);
        assert_eq!(decoded.nodes.iter().filter_map(|node| node.bitmap.as_ref()).map(|p| p.rgba.len() * 4).sum::<usize>(), 94_080_000);
        drop(decoded);
        let Value::Object(restored) = invoke(a, "import", &[packet.into(), registry.into()])? else { panic!("root"); };
        assert_eq!(stored(a, restored, "floorAlias"), stored(a, restored, "floor"));
        for i in 0..10 { assert_eq!(stored(a, restored, &format!("cellState{i}")), text.into()); }
        for (index, key) in ["floor", "cover", "decalMask"].iter().enumerate() {
            let Value::Object(value) = stored(a, restored, key) else { panic!("surface"); };
            let NativeObject::BitmapData(bitmap) = value.native() else { panic!("bitmap"); };
            assert!(!bitmap.ptr_eq(originals[index].1));
            assert_eq!((bitmap.width(), bitmap.height(), bitmap.transparency()), (width, height, index != 0));
            let restored_data = bitmap.sync(a.context.renderer);
            let original_data = originals[index].1.sync(a.context.renderer);
            assert_eq!(restored_data.borrow().pixels(), original_data.borrow().pixels());
        }
        assert_eq!(wire(a, restored.into(), registry), packet);
        Ok(())
    });
}

// Frozen v4 packet writer, retained as an independent compatibility oracle.
// Its per-pixel copy and late wire-limit check are intentionally unchanged.
fn frozen_v4_pixel_loop_packet(graph: &Graph) -> ResultG<String> {
    let mut w = Writer(Vec::new());
    w.0.extend(b"BHG\x01"); w.u8(graph.swf_version);
    w.u32(graph.nodes.len() as u32); w.u32(graph.fields as u32); w.atom(&graph.root)?;
    for node in &graph.nodes {
        w.u8(node.kind);
        if let Some(bitmap) = &node.bitmap {
            w.u32(bitmap.width); w.u32(bitmap.height); w.u8(u8::from(bitmap.transparent));
            for color in &bitmap.rgba { w.0.extend(color); }
        }
        w.u32(node.fields.len() as u32);
        for field in &node.fields { w.string(&field.name)?; w.u16(field.flags); w.atom(&field.value)?; }
        w.check()?;
    }
    let mut compressor = ZlibEncoder::new(Vec::new(), Compression::fast());
    compressor.write_all(&w.0).map_err(|e| format!("graph compression failed: {e}"))?;
    let packed = compressor.finish().map_err(|e| format!("graph compression failed: {e}"))?;
    let mut out = String::with_capacity(PREFIX.len() + 2 * packed.len()); out.push_str(PREFIX);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in packed { out.push(HEX[(b >> 4) as usize] as char); out.push(HEX[(b & 15) as usize] as char); }
    if out.len() > MAX_WIRE { return Err("graph wire limit exceeded".into()); }
    Ok(out)
}


#[test]
fn native_graph_bulk_packet_matches_v4_bytes_and_keeps_wire_limit() {
    // Compare complete compressed ASCII packets, not only self-roundtrip:
    // old and new serializers must agree on every tested premultiplied byte.
    for (width, height) in [(1u32, 1u32), (2, 3), (33, 17)] {
        for transparent in [false, true] {
            let rgba = (0..width * height).map(|i| {
                let a = if transparent { (i.wrapping_mul(37) & 255) as u8 } else { 255 };
                [a / 2, a / 3, a / 5, a]
            }).collect();
            let graph = Graph { swf_version: 8, root: Atom::Ref(0), fields: 3, nodes: vec![Node {
                kind: 2, bitmap: Some(Pixels { width, height, transparent, rgba }), fields: vec![
                    Field { name: vec![120], flags: 1, value: Atom::Number(0x8000000000000000) },
                    Field { name: vec![121], flags: 0x8000, value: Atom::Number(0x7ff8000000001234) },
                    Field { name: vec![0xd800], flags: 0, value: Atom::String(vec![0, 65, 0xdc00, 0xffff]) },
                ],
            }] };
            assert_eq!(pack(&graph).unwrap(), frozen_v4_pixel_loop_packet(&graph).unwrap());
        }
    }
    // High-entropy UTF-16 stays inside decoded128 yet exceeds unchanged native
    // ASCII64+1024. Export must refuse instead of expanding the output limit.
    assert_eq!(MAX_WIRE, 2 * (32 * 1024 * 1024) + 1024);
    let mut state = 0x6a09e667u32;
    let fields = (0u16..17).map(|id| {
        let value = (0..MAX_STRING).map(|_| {
            state ^= state << 13; state ^= state >> 17; state ^= state << 5;
            (state >> 16) as u16
        }).collect();
        Field { name: vec![id], flags: 0, value: Atom::String(value) }
    }).collect();
    let graph = Graph { swf_version: 8, root: Atom::Ref(0), fields: 17,
        nodes: vec![Node { kind: 0, bitmap: None, fields }] };
    assert_eq!(pack(&graph).unwrap_err(), "graph wire limit exceeded");
}

#[test]
fn native_graph_deep_anchor_numeric_payload_keeps_exact_object_paths_and_aliases() {
    with_avm(8, |a, _| {
        let asset = object(a);
        let first = object(a);
        let unicode = object(a);
        let array_child = object(a);
        let numbers = Object::new_with_native(&a.context.strings, Some(a.prototypes().array), NativeObject::Array(()));
        define(a, numbers, "length", 8193.0.into(), Attribute::DONT_ENUM | Attribute::DONT_DELETE);
        // Dense primitive geometry is irrelevant to anchor naming, but all
        // object edges within the same Array must still be discovered.
        for index in 0..8192 {
            define(a, numbers, &index.to_string(), (index as f64 * 0.125).into(), Attribute::empty());
        }
        define(a, numbers, "8192", array_child.into(), Attribute::empty());
        define(a, asset, "z", first.into(), Attribute::empty());
        define(a, asset, "a", first.into(), Attribute::empty());
        define(a, asset, "0", Value::Null, Attribute::empty());
        define(a, asset, "aa", 42.0.into(), Attribute::empty());
        define(a, asset, "numbers", numbers.into(), Attribute::empty());
        let unicode_key = AvmString::new(a.gc(), WStr::from_units(&[0xd800u16, 0x0062][..]));
        asset.define_value(a.gc(), unicode_key, unicode.into(), Attribute::empty());
        define(a, first, "back", asset.into(), Attribute::empty());
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("Array", a.prototypes().array.into(), false), ("asset", asset.into(), true)]);
        let root = object(a);
        define(a, root, "first", first.into(), Attribute::empty());
        define(a, root, "unicode", unicode.into(), Attribute::empty());
        define(a, root, "last", array_child.into(), Attribute::empty());
        let packet = wire(a, root.into(), registry);
        let graph = unpack(packet).unwrap();
        let field = |key: &str| graph.nodes[0].fields.iter()
            .find(|field| field.name == key.encode_utf16().collect::<Vec<_>>()).unwrap().value.clone();
        assert_eq!(field("first"), Atom::Anchor("asset/0061".into(), 0));
        assert_eq!(field("unicode"), Atom::Anchor("asset/d8000062".into(), 0));
        assert_eq!(field("last"), Atom::Anchor("asset/006e0075006d0062006500720073/0038003100390032".into(), 0));
        let Value::Object(restored) = invoke(a, "import", &[packet.into(), registry.into()])? else { panic!("root"); };
        assert_eq!(stored(a, restored, "first"), first.into());
        assert_eq!(stored(a, restored, "unicode"), unicode.into());
        assert_eq!(stored(a, restored, "last"), array_child.into());
        assert_eq!(wire(a, restored.into(), registry), packet);
        Ok(())
    });
}

#[test]
fn native_graph_deep_anchor_alias_keeps_exact_path_limit_rejection() {
    with_avm(8, |a, _| {
        let asset = object(a);
        let child = object(a);
        define(a, asset, "a", child.into(), Attribute::empty());
        let allowed_id = "x".repeat(2043);
        let allowed = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("known", child.into(), false), (&allowed_id, asset.into(), true)]);
        let packet = wire(a, child.into(), allowed);
        assert_eq!(unpack(packet).unwrap().root, Atom::Anchor("known".into(), 0));
        // The unused generated alias path is nevertheless 2049 bytes. It was
        // rejected by the old traversal and must not slip past the new one.
        let oversized_id = "x".repeat(2044);
        let oversized = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("known", child.into(), false), (&oversized_id, asset.into(), true)]);
        assert!(invoke(a, "export", &[child.into(), oversized.into()]).is_err());
        Ok(())
    });
}

#[test]
fn native_graph_deep_anchor_filter_never_hides_unsupported_virtual_fields() {
    with_avm(8, |a, _| {
        let asset = object(a);
        define(a, asset, "data", 123.0.into(), Attribute::empty());
        let callback = function(a, must_not_run);
        asset.add_property(a.gc(), name(a, "primitiveGetter"), callback, None, Attribute::empty());
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("asset", asset.into(), true)]);
        assert!(invoke(a, "export", &[Value::Null, registry.into()]).is_err());
        Ok(())
    });
}


// Exact pre-v5 anchor expansion copied before editing the production module.
// It retains String IDs, randomized HashMaps, full property vectors and the
// original queue. Keep this oracle independent of new accessors/hashers.
struct FrozenV4Anchors<'gc> {
    values: HashMap<String, Value<'gc>>,
    names: HashMap<Identity, String>,
    // AVM1 stores both direct StageObject values and path-based MovieClip
    // values. They can denote the same native clip without being the same
    // Value kind. Preserve that kind in the wire and at the receiving VM.
    stage_variants: HashMap<(String, u8), Value<'gc>>,
}

impl<'gc> FrozenV4Anchors<'gc> {
    fn insert(&mut self, id: String, value: Value<'gc>) -> ResultG<bool> {
        let key = identity(value).ok_or("anchor has a primitive value")?;
        anchor_kind(value)?;
        if let Some(previous) = self.values.get(&id) {
            if identity(*previous) != Some(key.clone()) || anchor_kind(*previous)? != anchor_kind(value)? {
                return Err(format!("anchor ID points to different objects: {id}"));
            }
            return Ok(false);
        }
        if self.values.len() >= MAX_ANCHORS { return Err("anchor count limit exceeded".into()); }
        self.values.insert(id.clone(), value);
        let new_identity = !self.names.contains_key(&key);
        self.names.entry(key).or_insert(id);
        Ok(new_identity)
    }

    fn insert_stage_variants(&mut self, id: &str, value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<()> {
        let (object, reference) = match value {
            Value::MovieClip(reference) => {
                let object = reference.coerce_to_object(activation)
                    .ok_or_else(|| format!("unresolved MovieClip anchor: {id}"))?;
                if !matches!(object.boxhead_graph_native(), NativeObject::MovieClip(_)) {
                    return Err(format!("MovieClip anchor resolved to another native kind: {id}"));
                }
                (object, reference)
            }
            Value::Object(object) if matches!(object.boxhead_graph_native(), NativeObject::MovieClip(_)) => {
                let reference = MovieClipReference::try_from_stage_object(activation, object)
                    .ok_or_else(|| format!("native MovieClip anchor has no stage reference: {id}"))?;
                (object, reference)
            }
            _ => return Ok(()),
        };
        // Native display-tree resolution does not read AS2 properties, invoke
        // user getters or run game code. No arbitrary same-path object match
        // is accepted: the direct object comes from this actual reference.
        for variant in [Value::Object(object), Value::MovieClip(reference)] {
            let kind = anchor_kind(variant)?;
            let key = identity(variant).ok_or("invalid MovieClip anchor identity")?;
            if let Some(previous) = self.names.get(&key) {
                if let Some(Value::Object(previous_object)) = self.stage_variants.get(&(previous.clone(),3)) {
                    if !Object::ptr_eq(*previous_object,object) {
                        return Err(format!("ambiguous MovieClip anchor path: {id}"));
                    }
                }
            }
            self.names.entry(key).or_insert_with(|| id.to_owned());
            self.stage_variants.insert((id.to_owned(),kind),variant);
        }
        Ok(())
    }

    fn read(value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Self> {
        let Value::Object(array) = value else { return Err("anchors must be an Array".into()); };
        if !matches!(array.boxhead_graph_native(), NativeObject::Array(_)) {
            return Err("anchors must be a native Array".into());
        }
        array.boxhead_graph_properties().map_err(str::to_owned)?;
        let Some(Value::Number(length)) = raw(array, "length", activation) else {
            return Err("anchor Array has no data length".into());
        };
        if !length.is_finite() || length.fract() != 0.0 || !(0.0..=MAX_ANCHORS as f64).contains(&length) {
            return Err("invalid anchor Array length".into());
        }
        let mut result = Self { values: HashMap::new(), names: HashMap::new(), stage_variants: HashMap::new() };
        let mut deep = VecDeque::new();
        for index in 0..length as usize {
            if index % 128 == 0 { check_time(activation)?; }
            let Some(Value::Object(row)) = raw(array, &index.to_string(), activation) else {
                return Err(format!("anchor row {index} is absent or invalid"));
            };
            if !matches!(row.boxhead_graph_native(), NativeObject::None) {
                return Err(format!("anchor row {index} is not an ordinary object"));
            }
            let properties = row.boxhead_graph_properties().map_err(str::to_owned)?;
            for (key, _, _) in &properties {
                if !["id", "value", "deep", "__proto__"].iter().any(|allowed| key.eq_with_case(allowed.as_bytes(), true)) {
                    return Err(format!("unknown anchor row field at {index}"));
                }
            }
            let Some(Value::String(id)) = raw(row, "id", activation) else {
                return Err(format!("anchor row {index} lacks a string ID"));
            };
            let id = ascii_id(id)?;
            let value = raw(row, "value", activation).ok_or("anchor row lacks value")?;
            let deep_flag = match raw(row, "deep", activation) {
                None | Some(Value::Bool(false)) => false,
                Some(Value::Bool(true)) => true,
                _ => return Err("anchor deep flag must be boolean".into()),
            };
            result.insert(id.clone(), value)?;
            result.insert_stage_variants(&id, value, activation)?;
            if deep_flag { deep.push_back((id, value)); }
        }
        // Explicit names always win over generated immutable-asset paths.
        let mut traversed = HashSet::new();
        let mut walked_fields = 0usize;
        while let Some((id, value)) = deep.pop_front() {
            check_time(activation)?;
            let Value::Object(object) = value else { continue; };
            if !matches!(object.boxhead_graph_native(), NativeObject::None | NativeObject::Array(_)) { continue; }
            if !traversed.insert(object.as_ptr() as usize) { continue; }
            let mut fields = object.boxhead_graph_properties().map_err(|e| format!("deep anchor {id}: {e}"))?;
            // The native property reader has already checked the whole object
            // for virtual properties, watchers and unsupported interfaces. All
            // fields still count towards the same bound, including primitives.
            // Only object edges can create names: sorting numeric vertex data
            // or other primitive payload cannot affect the canonical names.
            walked_fields = walked_fields.checked_add(fields.len())
                .ok_or("deep anchor field limit exceeded")?;
            if walked_fields > MAX_FIELDS * 4 { return Err("deep anchor field limit exceeded".into()); }
            fields.retain(|(key, child, _)| !key.eq_with_case(b"__proto__", true) && identity(*child).is_some());
            fields.sort_by(|a, b| a.0.iter().cmp(b.0.iter()));
            for (key, child, _) in fields {
                // Preserve the previous path bound even for aliases whose
                // generated path is not used. Allocate/format the path only
                // for a newly discovered identity, with no per-unit formatter.
                let child_len = key.len().checked_mul(4).and_then(|n| n.checked_add(id.len() + 1))
                    .ok_or("deep anchor path limit exceeded")?;
                if child_len > 2048 { return Err("deep anchor path limit exceeded".into()); }
                let identity = identity(child).unwrap();
                // Do not create alias paths recursively; retain one canonical name.
                if let Some(existing) = result.names.get(&identity) {
                    deep.push_back((existing.clone(), child));
                } else {
                    const HEX: &[u8; 16] = b"0123456789abcdef";
                    let mut child_id = String::with_capacity(child_len);
                    child_id.push_str(&id);
                    child_id.push('/');
                    for unit in key.iter() {
                        for shift in [12, 8, 4, 0] {
                            child_id.push(HEX[((unit >> shift) & 15) as usize] as char);
                        }
                    }
                    result.insert(child_id.clone(), child)?;
                    result.insert_stage_variants(&child_id, child, activation)?;
                    deep.push_back((child_id, child));
                }
            }
        }
        Ok(result)
    }

    fn atom(&self, value: Value<'gc>, activation: &mut Activation<'_, 'gc>) -> ResultG<Option<Atom>> {
        let Some(key) = identity(value) else { return Ok(None); };
        let Some(id) = self.names.get(&key) else { return Ok(None); };
        if let Value::MovieClip(reference) = value {
            let object = reference.coerce_to_object(activation)
                .ok_or_else(|| format!("checkpoint MovieClip anchor no longer resolves: {id}"))?;
            let Some(Value::Object(expected)) = self.stage_variants.get(&(id.clone(),3)) else {
                return Err(format!("checkpoint MovieClip anchor lacks its native object: {id}"));
            };
            if !Object::ptr_eq(object,*expected) {
                return Err(format!("checkpoint MovieClip anchor identity differs: {id}"));
            }
        }
        Ok(Some(Atom::Anchor(id.clone(),anchor_kind(value)?)))
    }

    fn resolve(&self, name: &str, kind: u8) -> ResultG<Value<'gc>> {
        let value = *self.values.get(name).ok_or_else(|| format!("missing checkpoint anchor: {name}"))?;
        if anchor_kind(value)? == kind { return Ok(value); }
        self.stage_variants.get(&(name.to_owned(),kind)).copied()
            .ok_or_else(|| format!("checkpoint anchor kind mismatch: {name}"))
    }
}

fn frozen_bindings_for_unchanged_export<'gc>(old: &FrozenV4Anchors<'gc>) -> Anchors<'gc> {
    // Transfer only the already-decided oracle bindings. This does not run
    // the new traversal, accessor, queue, insertion or name comparison policy.
    // Every oracle name remains a fully materialized explicit String here.
    let mut result = Anchors::empty();
    let mut ids = HashMap::new();
    for (text, value) in &old.values {
        let id = AnchorNameId(result.values.len() as u32);
        let hash = anchor_name_hash(text.as_bytes());
        let collision = result.name_buckets.insert(hash, id);
        result.values.push(NamedAnchor { name: AnchorName::Explicit(Rc::from(text.as_str())),
            length: text.len(), hash, collision, value: *value });
        ids.insert(text.as_str(), id);
    }
    result.names = old.names.iter().map(|(key, text)| (key.clone(), ids[text.as_str()])).collect();
    result.stage_variants = old.stage_variants.iter().map(|((text, kind), value)|
        ((ids[text.as_str()], *kind), *value)).collect();
    result
}

fn compare_anchor_bindings<'gc>(a: &mut Activation<'_, 'gc>, current: &Anchors<'gc>, old: &FrozenV4Anchors<'gc>) {
    assert_eq!(current.values.len(), old.values.len());
    assert_eq!(current.names.len(), old.names.len());
    assert_eq!(current.stage_variants.len(), old.stage_variants.len());
    for (key, id) in &old.names {
        assert_eq!(current.names.get(key).map(|name| current.materialize(*name)), Some(id.clone()));
    }
    for (id, value) in &old.values {
        assert_eq!(current.find_name(id).map(|name| current.values[name.0 as usize].value), Some(*value));
        assert_eq!(current.atom(*value, a).unwrap(), old.atom(*value, a).unwrap());
        for kind in [0, 1, 2, 3, 7, 64, 255] {
            assert_eq!(current.resolve(id, kind), old.resolve(id, kind));
        }
    }
    for ((id, kind), value) in &old.stage_variants {
        assert_eq!(current.stage_variants.get(&(current.find_name(id).unwrap(), *kind)), Some(value));
        assert_eq!(current.atom(*value, a).unwrap(), old.atom(*value, a).unwrap());
    }
}

#[test]
fn native_graph_shared_anchor_tables_match_frozen_v4_bytes_and_bfs_names() {
    with_avm(8, |a, _| {
        for reverse in [false, true] {
            let asset = object(a);
            let other = object(a);
            let shared = object(a);
            let old_orphan = object(a);
            let new_orphan = object(a);
            let nodes: Vec<_> = (0..320).map(|_| object(a)).collect();
            let opaque = function(a, must_not_run);
            // Opaque native anchors were not traversed by v4, even if they
            // have a private virtual descriptor. Queue pruning must agree.
            opaque.add_property(a.gc(), name(a, "opaqueTrap"), function(a, must_not_run), None, Attribute::empty());
            let clip = a.base_clip().object1().unwrap();
            let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
            let bitmap = Object::new_with_native(&a.context.strings, Some(a.prototypes().object),
                NativeObject::BitmapData(BitmapData::new_with_pixels(a.gc(), 1, 1, true, vec![Color::rgba(0, 0, 0, 0)])));
            let numeric = Object::new_with_native(&a.context.strings, Some(a.prototypes().array), NativeObject::Array(()));
            define(a, numeric, "length", 2049.0.into(), Attribute::DONT_ENUM | Attribute::DONT_DELETE);
            for index in 0..2048 { define(a, numeric, &index.to_string(), (index as f64).into(), Attribute::empty()); }
            define(a, numeric, "2048", shared.into(), Attribute::empty());
            for ordinal in 0..nodes.len() {
                let index = if reverse { nodes.len() - ordinal - 1 } else { ordinal };
                define(a, asset, &format!("k{index:04}"), nodes[index].into(), Attribute::empty());
                define(a, nodes[index], "back", asset.into(), Attribute::empty());
                define(a, nodes[index], "shared", shared.into(), Attribute::empty());
                define(a, nodes[index], "scalar", (index as f64).into(), Attribute::VERSION_10 | Attribute::DONT_ENUM);
            }
            for (key, value) in [("function", opaque.into()), ("clip-direct", clip.into()),
                ("clip-reference", Value::MovieClip(reference)), ("bitmap", bitmap.into()),
                ("numeric", numeric.into()), ("orphan", old_orphan.into()), ("alias", shared.into())]
            {
                define(a, asset, key, value, Attribute::empty());
            }
            let unicode_key = AvmString::new(a.gc(), WStr::from_units(&[0xd800u16, 0, 0xffff][..]));
            asset.define_value(a.gc(), unicode_key, other.into(), Attribute::empty());
            define(a, other, "early-child", nodes[0].into(), Attribute::empty());
            let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
                ("Array", a.prototypes().array.into(), false), ("named-shared", shared.into(), false),
                ("first", asset.into(), false), ("alias-prefix", asset.into(), true),
                ("later-deep-alias", asset.into(), true), ("other", other.into(), true),
                ("first", asset.into(), false)]);
            let root = object(a);
            for (index, value) in nodes.iter().enumerate() {
                define(a, root, &format!("node{index}"), (*value).into(), Attribute::empty());
            }
            define(a, root, "opaque", opaque.into(), Attribute::empty());
            define(a, root, "clip", Value::MovieClip(reference), Attribute::empty());
            define(a, root, "bitmap", bitmap.into(), Attribute::empty());
            define(a, root, "orphan", old_orphan.into(), Attribute::empty());
            let old = FrozenV4Anchors::read(registry.into(), a).unwrap();
            let current = Anchors::read(registry.into(), a).unwrap();
            compare_anchor_bindings(a, &current, &old);
            assert_eq!(current.materialize(*current.names.get(&identity(asset.into()).unwrap()).unwrap()), "first");
            assert_eq!(current.materialize(*current.names.get(&identity(nodes[0].into()).unwrap()).unwrap()),
                "alias-prefix/006b0030003000300030");
            let generated = export_graph(root.into(), &current, a).unwrap();
            let reference = export_graph(root.into(), &frozen_bindings_for_unchanged_export(&old), a).unwrap();
            assert_eq!(generated, reference);
            assert_eq!(pack(&generated).unwrap(), frozen_v4_pixel_loop_packet(&reference).unwrap());
            let packet = pack(&generated).unwrap();
            let Value::Object(restored) = import_graph(&generated, &current, a).unwrap() else { panic!("root"); };
            assert_eq!(pack(&export_graph(restored.into(), &current, a).unwrap()).unwrap(), packet);
            // Every call starts from fresh edges: replacing a static-looking
            // asset child cannot retain an old identity or canonical binding.
            define(a, asset, "orphan", new_orphan.into(), Attribute::empty());
            let fresh = Anchors::read(registry.into(), a).unwrap();
            let old_fresh = FrozenV4Anchors::read(registry.into(), a).unwrap();
            compare_anchor_bindings(a, &fresh, &old_fresh);
            assert!(!fresh.names.contains_key(&identity(old_orphan.into()).unwrap()));
            assert!(fresh.names.contains_key(&identity(new_orphan.into()).unwrap()));
        }
        Ok(())
    });
}

#[test]
fn native_graph_shared_anchor_tables_keep_frozen_v4_error_precedence() {
    with_avm(8, |a, _| {
        for case in 0..10 {
            let asset = object(a);
            let child = object(a);
            let other = object(a);
            let opaque = function(a, must_not_run);
            let mut registry = anchors(a, &[("Object", a.prototypes().object.into(), false), ("asset", asset.into(), true)]);
            match case {
                0 => registry = anchors(a, &[("same", asset.into(), false), ("same", other.into(), false)]),
                1 => registry = anchors(a, &[("primitive", Value::Number(1.0), true)]),
                2 => {
                    let Value::Object(row) = stored(a, registry, "0") else { panic!("row"); };
                    define(a, row, "deep", Value::Number(1.0), Attribute::empty());
                }
                3 => {
                    let Value::Object(row) = stored(a, registry, "0") else { panic!("row"); };
                    define(a, row, "extra", Value::Null, Attribute::empty());
                    asset.add_property(a.gc(), name(a, "laterVirtual"), opaque, None, Attribute::empty());
                }
                4 => { asset.add_property(a.gc(), name(a, "__proto__"), opaque, None, Attribute::DONT_ENUM); }
                5 => {
                    let key = name(a, "hidden");
                    asset.watch(a, key, opaque, Value::Undefined);
                }
                6 => { asset.set_interfaces(a.gc(), vec![]); }
                7 => {
                    define(a, asset, "a", child.into(), Attribute::empty());
                    registry = anchors(a, &[("known", child.into(), false), (&"x".repeat(2044), asset.into(), true)]);
                }
                8 => {
                    define(a, asset, "a", opaque.into(), Attribute::empty());
                    registry = anchors(a, &[("canonical-short", asset.into(), false),
                        (&"x".repeat(2044), asset.into(), true), ("later-short", asset.into(), true),
                        ("known-opaque", opaque.into(), false)]);
                }
                9 => define(a, registry, "length", ((MAX_ANCHORS + 1) as f64).into(), Attribute::empty()),
                _ => unreachable!(),
            }
            let previous = FrozenV4Anchors::read(registry.into(), a).err().expect("old must reject");
            let current = Anchors::read(registry.into(), a).err().expect("new must reject");
            assert_eq!(current, previous, "case {case}");
        }
        Ok(())
    });
}

#[test]
fn native_graph_raw_anchor_edges_match_complete_property_count_and_validation() {
    with_avm(8, |a, _| {
        let source = object(a);
        let child = object(a);
        let clip = a.base_clip().object1().unwrap();
        let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
        for index in 0..4096 {
            define(a, source, &format!("number{index}"), (index as f64).into(), Attribute::DONT_ENUM | Attribute::VERSION_10);
        }
        define(a, source, "", child.into(), Attribute::READ_ONLY);
        define(a, source, "reference", Value::MovieClip(reference), Attribute::empty());
        let properties = source.boxhead_graph_properties().unwrap();
        let expected: Vec<_> = properties.iter().filter(|(key, value, _)|
            !key.eq_with_case(b"__proto__", true) && identity(*value).is_some())
            .map(|(key, value, _)| (*key, *value)).collect();
        let (count, edges) = source.boxhead_graph_anchor_edges().unwrap();
        assert_eq!(count, properties.len()); assert_eq!(count, 4099);
        assert_eq!(edges, expected); assert_eq!(edges.len(), 2);
        for case in 0..3 {
            let rejected = object(a);
            let callback = function(a, must_not_run);
            match case {
                0 => { rejected.add_property(a.gc(), name(a, "primitive"), callback, Some(callback), Attribute::DONT_ENUM); }
                1 => {
                    let key = name(a, "primitive");
                    rejected.watch(a, key, callback, Value::Null);
                }
                2 => { rejected.set_interfaces(a.gc(), vec![]); }
                _ => unreachable!(),
            }
            assert_eq!(rejected.boxhead_graph_anchor_edges().err(), rejected.boxhead_graph_properties().err());
            assert!(rejected.boxhead_graph_anchor_edges().is_err());
        }
        Ok(())
    });
}

#[test]
fn native_graph_shared_anchor_tables_keep_exact_capacity_and_duplicate_rules() {
    with_avm(8, |a, _| {
        assert_eq!(MAX_ANCHORS, 250_000);
        let value: Value<'_> = object(a).into();
        let other: Value<'_> = object(a).into();
        let mut current = Anchors::empty();
        let mut old = FrozenV4Anchors { values: HashMap::new(), names: HashMap::new(), stage_variants: HashMap::new() };
        for index in 0..MAX_ANCHORS {
            let id = index.to_string();
            assert_eq!(current.insert(AnchorName::Explicit(Rc::from(id.as_str())), value).map(|(_, fresh)| fresh), old.insert(id, value));
        }
        assert_eq!(current.values.len(), MAX_ANCHORS); assert_eq!(current.names.len(), 1);
        for (id, child) in [("0", value), ("0", other), ("new", value), ("primitive", Value::Null)] {
            assert_eq!(current.insert(AnchorName::Explicit(Rc::from(id)), child).map(|(_, fresh)| fresh), old.insert(id.into(), child));
        }
        assert_eq!(current.insert(AnchorName::Explicit(Rc::from("new")), value).unwrap_err(), "anchor count limit exceeded");
        let canonical = current.names.get(&identity(value).unwrap()).unwrap();
        let stored_id = current.find_name(&current.materialize(*canonical)).unwrap();
        assert_eq!(*canonical, stored_id, "canonical and lookup names must share the same arena entry");
        Ok(())
    });
}

#[test]
fn native_graph_pruned_anchor_queue_keeps_raw_field_and_timeout_bounds() {
    assert_eq!(MAX_FIELDS, 1_000_000);
    assert_eq!(deep_field_total(0, 4_000_000).unwrap(), 4_000_000);
    assert_eq!(deep_field_total(3_995_901, 4099).unwrap(), 4_000_000);
    for (before, fields) in [(4_000_000, 1), (3_995_902, 4099), (usize::MAX, 1)] {
        assert_eq!(deep_field_total(before, fields).unwrap_err(), "deep anchor field limit exceeded");
    }
    with_avm(8, |a, _| {
        let empty = anchors(a, &[]);
        let ordinary = object(a);
        let opaque = function(a, must_not_run);
        let opaque_only = anchors(a, &[("opaque", opaque.into(), true), ("ordinary", ordinary.into(), true),
            ("ordinary-alias", ordinary.into(), true)]);
        for registry in [empty, opaque_only] {
            let previous = a.context.max_execution_duration;
            a.context.max_execution_duration = Duration::ZERO;
            assert_eq!(Anchors::read(registry.into(), a).err().unwrap(), "native graph execution timeout");
            assert!(invoke(a, "export", &[Value::Null, registry.into()]).is_err());
            let invalid_packet = name(a, "BHG1:");
            assert!(invoke(a, "import", &[invalid_packet.into(), registry.into()]).is_err());
            a.context.max_execution_duration = previous;
        }
        Ok(())
    });
}

#[test]
fn native_graph_lazy_names_preserve_explicit_generated_collisions_and_segment_boundaries() {
    with_avm(8, |a, _| {
        let asset = object(a);
        let child = object(a);
        let other = object(a);
        define(a, asset, "a", child.into(), Attribute::empty());
        for conflict in [false, true] {
            let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
                ("asset", asset.into(), true), ("asset/0061", if conflict { other.into() } else { child.into() }, false)]);
            let old = FrozenV4Anchors::read(registry.into(), a);
            let current = Anchors::read(registry.into(), a);
            if conflict {
                assert_eq!(old.err().unwrap(), "anchor ID points to different objects: asset/0061");
                assert_eq!(current.err().unwrap(), "anchor ID points to different objects: asset/0061");
            } else {
                compare_anchor_bindings(a, &current.unwrap(), &old.unwrap());
            }
        }
        // Equal textual names must share an entry even when one representation
        // is a literal containing '/' and the other is a parent/key path.
        for literal_first in [false, true] {
            let mut current = Anchors::empty();
            let (parent, _) = current.insert(AnchorName::Explicit(Rc::from("asset")), asset.into()).unwrap();
            let literal = AnchorName::Explicit(Rc::from("asset/0061"));
            let generated = AnchorName::Child { parent, key: name(a, "a") };
            let (first, _) = current.insert(if literal_first { literal } else { generated }, child.into()).unwrap();
            let (same, fresh) = current.insert(if literal_first {
                AnchorName::Child { parent, key: name(a, "a") }
            } else { AnchorName::Explicit(Rc::from("asset/0061")) }, child.into()).unwrap();
            assert_eq!(same, first); assert!(!fresh); assert_eq!(current.values.len(), 2);
            assert_eq!(current.find_name("asset/0061"), Some(first));
            assert_eq!(current.materialize(first), "asset/0061");
            assert_eq!(current.insert(AnchorName::Child { parent, key: name(a, "a") }, other.into()).unwrap_err(),
                "anchor ID points to different objects: asset/0061");
            let (tail, _) = current.insert(AnchorName::Child { parent: first, key: name(a, "b") }, other.into()).unwrap();
            assert_eq!(current.materialize(tail), "asset/0061/0062");
            assert_eq!(current.find_name("asset/00610062"), None);
        }
        Ok(())
    });
}

#[test]
fn native_graph_lazy_names_compare_forced_hash_collisions_without_aliasing() {
    use std::hash::Hasher;
    with_avm(8, |a, _| {
        let asset = object(a);
        let children: Vec<_> = (0..48).map(|_| object(a)).collect();
        let root = object(a);
        for (index, child) in children.iter().enumerate() {
            let field = format!("k{index:02}");
            define(a, asset, &field, (*child).into(), Attribute::empty());
            define(a, root, &field, (*child).into(), Attribute::empty());
        }
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("first", asset.into(), false), ("alias", asset.into(), true)]);
        let old = FrozenV4Anchors::read(registry.into(), a).unwrap();
        let mut empty = Anchors::empty();
        empty.name_bucket_mask = 0;
        let current = Anchors::read_into(registry.into(), a, empty).unwrap();
        assert_eq!(current.name_buckets.len(), 1);
        compare_anchor_bindings(a, &current, &old);
        for (index, entry) in current.values.iter().enumerate() {
            let text = current.materialize(AnchorNameId(index as u32));
            let mut independent_hash = fnv::FnvHasher::default();
            independent_hash.write(text.as_bytes());
            assert_eq!(entry.hash, independent_hash.finish(), "incremental hash must be the complete raw byte hash");
            assert_eq!(current.find_name(&text), Some(AnchorNameId(index as u32)));
        }
        // Same lengths and the same forced bucket must not hide inequality,
        // alias a missing name, or convert a kind mismatch into a successful bind.
        assert_eq!(current.find_name("alias/006b00390039"), None);
        assert_eq!(current.resolve("alias/006b00300030", 2).unwrap_err(),
            "checkpoint anchor kind mismatch: alias/006b00300030");
        let generated = export_graph(root.into(), &current, a).unwrap();
        let reference = export_graph(root.into(), &frozen_bindings_for_unchanged_export(&old), a).unwrap();
        assert_eq!(pack(&generated).unwrap(), frozen_v4_pixel_loop_packet(&reference).unwrap());
        let Value::Object(restored) = import_graph(&generated, &current, a).unwrap() else { panic!("root"); };
        assert_eq!(pack(&export_graph(restored.into(), &current, a).unwrap()).unwrap(), pack(&generated).unwrap());
        Ok(())
    });
}

#[test]
fn native_graph_lazy_names_retain_utf16_empty_segments_and_exact_2048_limit() {
    with_avm(8, |a, _| {
        let asset = object(a);
        let empty_child = object(a);
        let unicode_child = object(a);
        let key = AvmString::new(a.gc(), WStr::from_units(&[0xd800u16, 0, 0xffff][..]));
        define(a, asset, "", empty_child.into(), Attribute::empty());
        empty_child.define_value(a.gc(), key, unicode_child.into(), Attribute::empty());
        let root_id = "x".repeat(2034);
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false), (&root_id, asset.into(), true)]);
        let old = FrozenV4Anchors::read(registry.into(), a).unwrap();
        let current = Anchors::read(registry.into(), a).unwrap();
        compare_anchor_bindings(a, &current, &old);
        let expected = format!("{root_id}//d8000000ffff");
        assert_eq!(expected.len(), 2048);
        assert_eq!(current.atom(unicode_child.into(), a).unwrap(), Some(Atom::Anchor(expected.clone(), 0)));
        assert_eq!(current.resolve(&expected, 0).unwrap(), unicode_child.into());
        assert_eq!(current.find_name(&format!("{root_id}/d8000000ffff")), None);
        let too_long = "x".repeat(2035);
        // The last edge is still rejected when the target already has a short
        // canonical name, before the alias/scheduled-identity pruning branch.
        let rejected = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("short", unicode_child.into(), false), (&too_long, asset.into(), true)]);
        assert_eq!(FrozenV4Anchors::read(rejected.into(), a).err().unwrap(), "deep anchor path limit exceeded");
        assert_eq!(Anchors::read(rejected.into(), a).err().unwrap(), "deep anchor path limit exceeded");
        Ok(())
    });
}

#[test]
fn native_graph_lazy_names_rebind_fresh_receiving_assets_and_keep_packet_bytes() {
    with_avm(8, |a, _| {
        let host_asset = object(a);
        let guest_asset = object(a);
        let host_proto = object(a);
        let guest_proto = object(a);
        let host_method = function(a, yes);
        let guest_method = function(a, no);
        for (asset, prototype, method) in [(host_asset, host_proto, host_method), (guest_asset, guest_proto, guest_method)] {
            define(a, asset, "prototype", prototype.into(), Attribute::empty());
            define(a, prototype, "Process", method.into(), Attribute::DONT_ENUM);
        }
        let host_registry = anchors(a, &[("Object", a.prototypes().object.into(), false), ("asset", host_asset.into(), true)]);
        let guest_registry = anchors(a, &[("Object", a.prototypes().object.into(), false), ("asset", guest_asset.into(), true)]);
        let root = Object::new(&a.context.strings, Some(host_proto));
        define(a, root, "Process", host_method.into(), Attribute::READ_ONLY);
        define(a, root, "alias", host_proto.into(), Attribute::empty());
        let packet = wire(a, root.into(), host_registry);
        let old = FrozenV4Anchors::read(host_registry.into(), a).unwrap();
        assert_eq!(packet.to_utf8_lossy().into_owned(), frozen_v4_pixel_loop_packet(
            &export_graph(root.into(), &frozen_bindings_for_unchanged_export(&old), a).unwrap()).unwrap());
        let Value::Object(restored) = invoke(a, "import", &[packet.into(), guest_registry.into()])? else { panic!("root"); };
        assert_eq!(stored(a, restored, "__proto__"), guest_proto.into());
        assert_eq!(stored(a, restored, "alias"), guest_proto.into());
        assert_eq!(stored(a, restored, "Process"), guest_method.into());
        assert_eq!(wire(a, restored.into(), guest_registry), packet);
        // A subsequent call must see replacement edges, despite identical
        // textual paths. No object, descriptor or canonical binding persists.
        let replacement_proto = object(a);
        let replacement_method = function(a, yes);
        define(a, replacement_proto, "Process", replacement_method.into(), Attribute::DONT_ENUM);
        define(a, guest_asset, "prototype", replacement_proto.into(), Attribute::empty());
        let Value::Object(rebound) = invoke(a, "import", &[packet.into(), guest_registry.into()])? else { panic!("root"); };
        assert_eq!(stored(a, rebound, "__proto__"), replacement_proto.into());
        assert_eq!(stored(a, rebound, "alias"), replacement_proto.into());
        assert_eq!(stored(a, rebound, "Process"), replacement_method.into());
        assert_eq!(wire(a, rebound.into(), guest_registry), packet);
        Ok(())
    });
}

#[test]
fn native_graph_lazy_names_keep_unemitted_geometry_paths_lazy_and_iterative() {
    with_avm(8, |a, _| {
        // Empty raw keys add only '/'. This reaches the actual maximum path
        // depth and proves materialization uses no recursive Rust call stack.
        let nodes: Vec<_> = (0..2048).map(|_| object(a)).collect();
        for pair in nodes.windows(2) { define(a, pair[0], "", pair[1].into(), Attribute::empty()); }
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false), ("x", nodes[0].into(), true)]);
        let current = Anchors::read(registry.into(), a).unwrap();
        let old = FrozenV4Anchors::read(registry.into(), a).unwrap();
        assert_eq!(current.values.len(), 2049);
        assert_eq!(current.values.iter().filter(|entry| matches!(&entry.name, AnchorName::Child { .. })).count(), 2047);
        let retained_text: usize = current.values.iter().map(|entry| match &entry.name {
            AnchorName::Explicit(text) => text.len(), AnchorName::Child { .. } => 0,
        }).sum();
        assert_eq!(retained_text, 7, "only the two explicit root names may retain full strings");
        let expected = format!("x{}", "/".repeat(2047));
        let last = *nodes.last().unwrap();
        assert_eq!(current.atom(last.into(), a).unwrap(), old.atom(last.into(), a).unwrap());
        assert_eq!(current.atom(last.into(), a).unwrap(), Some(Atom::Anchor(expected.clone(), 0)));
        assert_eq!(current.resolve(&expected, 0).unwrap(), last.into());
        let actual = export_graph(Value::Null, &current, a).unwrap();
        let reference = export_graph(Value::Null, &frozen_bindings_for_unchanged_export(&old), a).unwrap();
        assert_eq!(pack(&actual).unwrap(), frozen_v4_pixel_loop_packet(&reference).unwrap());
        let overflow = object(a);
        define(a, last, "", overflow.into(), Attribute::empty());
        assert_eq!(Anchors::read(registry.into(), a).err().unwrap(), "deep anchor path limit exceeded");
        assert_eq!(FrozenV4Anchors::read(registry.into(), a).err().unwrap(), "deep anchor path limit exceeded");
        Ok(())
    });
}

// ANCHOR_HOTPATH_TESTS_START
#[path = "frozen_v6.rs"]
mod frozen_v6;

#[test]
fn native_graph_hotpath_matches_frozen_v6_packets_for_mixed_aliases_and_variants() {
    with_avm(8, |a, _| {
        for reverse in [false, true] {
            let asset = object(a);
            let branch = object(a);
            let leaf = object(a);
            let opaque = function(a, must_not_run);
            opaque.add_property(a.gc(), name(a, "opaqueTrap"), opaque, None, Attribute::DONT_ENUM);
            let clip = a.base_clip().object1().unwrap();
            let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
            let bitmap = Object::new_with_native(&a.context.strings, Some(a.prototypes().object),
                NativeObject::BitmapData(BitmapData::new_with_pixels(a.gc(), 1, 1, true, vec![Color::rgba(13, 71, 209, 255)])));
            let values = [branch.into(), leaf.into(), opaque.into(), clip.into(), Value::MovieClip(reference), bitmap.into()];
            for offset in 0..values.len() {
                let index = if reverse { values.len() - offset - 1 } else { offset };
                define(a, asset, &format!("k{index}"), values[index], Attribute::VERSION_10 | Attribute::DONT_ENUM);
            }
            define(a, branch, "leaf", leaf.into(), Attribute::empty());
            define(a, branch, "back", asset.into(), Attribute::empty());
            define(a, leaf, "numeric", (-0.0_f64).into(), Attribute::READ_ONLY);
            let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
                ("canonical", asset.into(), false), ("expanded", asset.into(), true),
                ("later", asset.into(), true), ("clip-reference", Value::MovieClip(reference), true),
                ("clip-object", clip.into(), true), ("known-leaf", leaf.into(), false)]);
            let root = object(a);
            for (index, value) in values.into_iter().enumerate() {
                define(a, root, &format!("value{index}"), value, Attribute::empty());
            }
            define(a, root, "nan", f64::from_bits(0x7ff8_0000_0000_0021).into(), Attribute::READ_ONLY);
            define(a, root, "negativeZero", (-0.0_f64).into(), Attribute::VERSION_10);
            for collisions in [false, true] {
                assert_eq!(frozen_v6::assert_same(registry.into(), Some(root.into()), a, collisions), None);
            }
            let old = FrozenV4Anchors::read(registry.into(), a).unwrap();
            let current = Anchors::read(registry.into(), a).unwrap();
            compare_anchor_bindings(a, &current, &old);
        }
        Ok(())
    });
}

#[test]
fn native_graph_hotpath_dense_schedule_preserves_first_deep_alias_across_words() {
    with_avm(8, |a, _| {
        let parents: Vec<_> = (0..208).map(|_| object(a)).collect();
        let leaves: Vec<_> = (0..208).map(|_| object(a)).collect();
        let root = object(a);
        let mut rows = vec![("Object".to_owned(), a.prototypes().object.into(), false)];
        for index in 0..parents.len() {
            define(a, parents[index], "leaf", leaves[index].into(), Attribute::empty());
            define(a, leaves[index], "cycle", parents[index].into(), Attribute::empty());
            define(a, root, &format!("leaf{index}"), leaves[index].into(), Attribute::empty());
            rows.push((format!("canonical{index}"), parents[index].into(), false));
        }
        for index in (0..parents.len()).rev() {
            rows.push((format!("expanded{index}"), parents[index].into(), true));
            rows.push((format!("ignored-later{index}"), parents[index].into(), true));
        }
        let borrowed: Vec<_> = rows.iter().map(|(id, value, deep)| (id.as_str(), *value, *deep)).collect();
        let registry = anchors(a, &borrowed);
        assert_eq!(frozen_v6::assert_same(registry.into(), Some(root.into()), a, false), None);
        let current = Anchors::read(registry.into(), a).unwrap();
        let old = FrozenV4Anchors::read(registry.into(), a).unwrap();
        compare_anchor_bindings(a, &current, &old);
        for index in [0, 62, 63, 64, 126, 127, 128, 190, 191, 192, 207] {
            let id = current.names.get(&identity(leaves[index].into()).unwrap()).unwrap();
            assert_eq!(current.materialize(*id), format!("expanded{index}/006c006500610066"));
        }
        Ok(())
    });
}

#[test]
fn native_graph_hotpath_matches_frozen_v6_rejection_precedence() {
    with_avm(8, |a, _| {
        for case in 0..8 {
            let asset = object(a);
            let child = object(a);
            let other = object(a);
            let callback = function(a, must_not_run);
            let mut registry = anchors(a, &[("Object", a.prototypes().object.into(), false), ("asset", asset.into(), true)]);
            match case {
                0 => registry = anchors(a, &[("same", child.into(), false), ("same", callback.into(), true)]),
                1 => registry = anchors(a, &[("primitive", Value::Bool(true), true)]),
                2 => {
                    define(a, asset, "a", child.into(), Attribute::empty());
                    registry = anchors(a, &[("already-known", child.into(), true), (&"x".repeat(2044), asset.into(), true)]);
                }
                3 => {
                    define(a, asset, "a", child.into(), Attribute::empty());
                    asset.add_property(a.gc(), name(a, "__proto__"), callback, Some(callback), Attribute::DONT_ENUM);
                    registry = anchors(a, &[(&"x".repeat(2044), asset.into(), true)]);
                }
                4 => {
                    asset.set_interfaces(a.gc(), vec![]);
                    let key = name(a, "hidden");
                    asset.watch(a, key, callback, Value::Null);
                    asset.add_property(a.gc(), name(a, "virtual"), callback, None, Attribute::VERSION_10);
                }
                5 => {
                    let Value::Object(row) = stored(a, registry, "1") else { panic!("row"); };
                    define(a, row, "deep", 3.0.into(), Attribute::empty());
                    define(a, row, "unknown", Value::Null, Attribute::empty());
                }
                6 => {
                    define(a, asset, "a", child.into(), Attribute::empty());
                    registry = anchors(a, &[("asset", asset.into(), true), ("asset/0061", other.into(), false)]);
                }
                7 => define(a, registry, "length", ((MAX_ANCHORS + 1) as f64).into(), Attribute::empty()),
                _ => unreachable!(),
            }
            let old = FrozenV4Anchors::read(registry.into(), a).err().expect("invalid fixture must reject");
            for collisions in [false, true] {
                assert_eq!(frozen_v6::assert_same(registry.into(), None, a, collisions), Some(old.clone()), "case {case}");
            }
        }
        Ok(())
    });
}

#[test]
fn native_graph_hotpath_reuses_buffer_without_retaining_prior_object_edges() {
    with_avm(8, |a, _| {
        let first = object(a);
        let second = object(a);
        let child = object(a);
        let clip = a.base_clip().object1().unwrap();
        let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
        for index in 0..300 {
            define(a, first, &format!("scalar{index}"), (index as f64).into(), Attribute::DONT_ENUM | Attribute::VERSION_10);
        }
        define(a, first, "child", child.into(), Attribute::READ_ONLY);
        define(a, first, "reference", Value::MovieClip(reference), Attribute::empty());
        define(a, second, "scalar", 42.0.into(), Attribute::empty());
        let mut edges = vec![(name(a, "stale"), first.into())];
        for source in [first, second, first] {
            let complete = source.boxhead_graph_properties().unwrap();
            let expected: Vec<_> = complete.iter()
                .filter(|(key, value, _)| !key.eq_with_case(b"__proto__", true) && identity(*value).is_some())
                .map(|(key, value, _)| (*key, *value)).collect();
            let count = source.boxhead_graph_anchor_edges_into(&mut edges).unwrap();
            assert_eq!(count, complete.len());
            assert_eq!(edges, expected);
        }
        let capacity = edges.capacity();
        second.boxhead_graph_anchor_edges_into(&mut edges).unwrap();
        assert!(edges.is_empty());
        assert_eq!(edges.capacity(), capacity);
        for case in 0..3 {
            let rejected = object(a);
            let callback = function(a, must_not_run);
            match case {
                0 => { rejected.add_property(a.gc(), name(a, "hidden"), callback, Some(callback), Attribute::VERSION_10); }
                1 => {
                    let key = name(a, "hidden");
                    rejected.watch(a, key, callback, Value::Null);
                }
                2 => { rejected.set_interfaces(a.gc(), vec![]); }
                _ => unreachable!(),
            }
            edges.push((name(a, "stale"), child.into()));
            assert_eq!(rejected.boxhead_graph_anchor_edges_into(&mut edges).err(), rejected.boxhead_graph_properties().err());
            assert!(edges.is_empty(), "a failed fresh read must not retain another object's edges");
        }
        Ok(())
    });
}

#[test]
fn native_graph_hotpath_fresh_calls_observe_replaced_edges_kinds_and_flags() {
    with_avm(8, |a, _| {
        let asset = object(a);
        let first = object(a);
        let second = object(a);
        let callback = function(a, must_not_run);
        let clip = a.base_clip().object1().unwrap();
        let reference = MovieClipReference::try_from_stage_object(a, clip).unwrap();
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("canonical", asset.into(), false), ("expanded", asset.into(), true)]);
        let root = object(a);
        for (index, value) in [first.into(), second.into(), callback.into(), Value::MovieClip(reference), clip.into()].into_iter().enumerate() {
            define(a, asset, "edge", value, Attribute::DONT_ENUM | Attribute::VERSION_10);
            define(a, root, "same", value, if index % 2 == 0 { Attribute::READ_ONLY } else { Attribute::empty() });
            assert_eq!(frozen_v6::assert_same(registry.into(), Some(root.into()), a, false), None);
            let current = Anchors::read(registry.into(), a).unwrap();
            let old = FrozenV4Anchors::read(registry.into(), a).unwrap();
            compare_anchor_bindings(a, &current, &old);
            if index != 0 { assert!(!current.names.contains_key(&identity(first.into()).unwrap())); }
        }
        Ok(())
    });
}

#[test]
fn native_graph_hotpath_keeps_utf16_path_and_timeout_errors_before_alias_pruning() {
    with_avm(8, |a, _| {
        let asset = object(a);
        let child = object(a);
        let leaf = object(a);
        let key = AvmString::new(a.gc(), WStr::from_units(&[0xd800_u16, 0, 0xffff][..]));
        define(a, asset, "", child.into(), Attribute::empty());
        child.define_value(a.gc(), key, leaf.into(), Attribute::VERSION_10);
        for length in [2034, 2035] {
            let id = "x".repeat(length);
            let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
                ("known-leaf", leaf.into(), true), (&id, asset.into(), true), ("ignored-short-alias", asset.into(), true)]);
            let old = FrozenV4Anchors::read(registry.into(), a);
            let expected = if length == 2034 { None } else { Some("deep anchor path limit exceeded".to_owned()) };
            assert_eq!(old.err(), expected);
            assert_eq!(frozen_v6::assert_same(registry.into(), None, a, true), expected);
        }
        let registry = anchors(a, &[("Object", a.prototypes().object.into(), false),
            ("a", asset.into(), false), ("deep", asset.into(), true), ("alias", asset.into(), true)]);
        let duration = a.context.max_execution_duration;
        a.context.max_execution_duration = Duration::ZERO;
        assert_eq!(frozen_v6::assert_same(registry.into(), None, a, false), Some("native graph execution timeout".into()));
        a.context.max_execution_duration = duration;
        Ok(())
    });
}

