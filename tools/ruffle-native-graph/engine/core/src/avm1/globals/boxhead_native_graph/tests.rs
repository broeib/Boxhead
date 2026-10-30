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
