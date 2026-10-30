use super::{blend_row, frozen_v10, packed};
use crate::bitmap::bitmap_data::{BitmapData, Color, DirtyState};
use crate::context::UpdateContext;
use ruffle_render::bitmap::PixelRegion;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn premultiplied(index: usize, alpha: u8) -> Color {
    let channel = |factor: usize| ((index * factor + 3) % (usize::from(alpha) + 1)) as u8;
    Color::rgba(channel(11), channel(29), channel(47), alpha)
}

fn reference(dest: Color, source: Color, opaque: bool) -> Color {
    let inverse = 255u16 - u16::from(source.alpha());
    let channel = |d: u8, s: u8| s + (u16::from(d) * inverse / 255) as u8;
    Color::rgba(channel(dest.red(), source.red()), channel(dest.green(), source.green()),
        channel(dest.blue(), source.blue()), if opaque { 255 } else { channel(dest.alpha(), source.alpha()) })
}

fn compare_rows(initial: &[Color], source: &[Color], opaque: bool) {
    let mut expected = initial.to_vec();
    let mut actual = initial.to_vec();
    let old = catch_unwind(AssertUnwindSafe(|| frozen_v10::blend_row(&mut expected, source, opaque)));
    let new = catch_unwind(AssertUnwindSafe(|| blend_row(&mut actual, source, opaque)));
    assert_eq!(old.is_err(), new.is_err(), "overflow/panic behavior differs");
    assert_eq!(actual, expected, "output or prefix before panic differs");
}

fn with_bitmap_context(test: impl for<'gc> FnOnce(&mut UpdateContext<'gc>)) {
    let player = crate::player::PlayerBuilder::new()
        .with_movie(crate::tag_utils::SwfMovie::empty(8, None))
        .build();
    let mut player = player.lock().unwrap();
    player.mutate_with_update_context(test);
}

#[test]
fn bitmap_packed_div255_exhaustive_product_domain() {
    for product in 0..=65025u32 {
        let expected = product / 255;
        assert_eq!(packed::div255_lanes(product), expected);
        assert_eq!(packed::div255_lanes(product << 16), expected << 16);
    }
}

#[test]
fn bitmap_packed_independent_lane_carries_and_floor_boundaries() {
    for product in 0..=65025u32 {
        for boundary in [0, 1, 254, 255, 256, 65024, 65025] {
            assert_eq!(packed::div255_lanes(product | (boundary << 16)),
                product / 255 | ((boundary / 255) << 16));
            assert_eq!(packed::div255_lanes(boundary | (product << 16)),
                boundary / 255 | ((product / 255) << 16));
        }
    }
}

#[test]
fn bitmap_packed_both_word_orders_scale_the_same_rgba_bytes() {
    for alpha in 0..=255u8 {
        for component in 0..=255u8 {
            let bytes = [component, 255 - component, alpha, 255 - alpha];
            let expected = bytes.map(|value| (u16::from(value) * (255 - u16::from(alpha)) / 255) as u8);
            assert_eq!(packed::scale_word(u32::from_le_bytes(bytes), alpha).to_le_bytes(), expected);
            assert_eq!(packed::scale_word(u32::from_be_bytes(bytes), alpha).to_be_bytes(), expected);
        }
    }
}

#[test]
fn bitmap_packed_all_source_destination_alpha_pairs_match_frozen_v10() {
    for dest_alpha in 0..=255u8 {
        for source_alpha in 0..=255u8 {
            let dest = premultiplied(usize::from(source_alpha) + 31, dest_alpha);
            let source = premultiplied(usize::from(dest_alpha) + 17, source_alpha);
            for opaque in [false, true] {
                let mut expected = [dest];
                frozen_v10::blend_row(&mut expected, &[source], opaque);
                assert_eq!(packed::blend_pixel(dest, source, opaque), expected[0]);
                assert_eq!(expected[0], reference(dest, source, opaque));
            }
        }
    }
}

#[test]
fn bitmap_packed_short_rows_blocks_and_all_tail_boundaries_match_v10() {
    for length in [0, 1, 2, 3, 4, 7, 15, 31, 32, 33, 63, 64, 65, 95, 127, 128, 129, 159, 160, 161, 255, 257, 639, 640, 641] {
        for pattern in 0..4 {
            let source: Vec<_> = (0..length).map(|index| match pattern {
                0 => Color::rgba(0, 0, 0, 0),
                1 => premultiplied(index, 255),
                2 if index % 7 < 3 => Color::rgba(0, 0, 0, 0),
                2 => premultiplied(index, 255),
                _ => premultiplied(index, ((index * 17 + 1) % 256) as u8),
            }).collect();
            // Arbitrary raw destination RGB is allowed even when RGB>A.
            let initial: Vec<_> = (0..length).map(|index| Color::rgba(
                (index * 23) as u8, (index * 31) as u8, 251, (index * 11) as u8)).collect();
            for opaque in [false, true] { compare_rows(&initial, &source, opaque); }
        }
    }
}

#[test]
fn bitmap_packed_raw_source_channels_keep_actual_checked_or_wrapping_semantics() {
    for alpha in [0, 1, 2, 127, 128, 254, 255] {
        for dest in [0, 1, 63, 127, 128, 254, 255] {
            for source in [0, 1, 63, 127, 128, 254, 255] {
                let initial = [Color::rgba(dest, 255 - dest, 137, 85)];
                let incoming = [Color::rgba(source, 255 - source, 11, alpha)];
                for opaque in [false, true] { compare_rows(&initial, &incoming, opaque); }
            }
        }
    }
}

#[test]
fn bitmap_packed_partial_row_before_overflow_is_identical_to_frozen_v10() {
    for length in [7, 31, 32, 33, 64, 127, 128, 129, 257] {
        for failure_index in [0, length / 2, length - 1] {
            let initial = vec![Color::rgba(249, 199, 149, 17); length];
            let mut source = vec![Color::rgba(1, 2, 3, 9); length];
            source[failure_index] = Color::rgba(250, 251, 252, 0);
            for opaque in [false, true] { compare_rows(&initial, &source, opaque); }
        }
    }
}

#[test]
fn bitmap_packed_alpha_zero_nonzero_rgb_is_never_treated_as_black() {
    for length in [1, 31, 32, 65, 128, 161, 640] {
        let initial = vec![Color::rgba(17, 23, 31, 41); length];
        let source = vec![Color::rgba(7, 11, 13, 0); length];
        for opaque in [false, true] {
            let mut actual = initial.clone(); blend_row(&mut actual, &source, opaque);
            assert!(actual.iter().all(|color| *color == Color::rgba(24, 34, 44, if opaque { 255 } else { 41 })));
            compare_rows(&initial, &source, opaque);
        }
    }
}

#[test]
fn bitmap_packed_homogeneous_v10_fastpaths_keep_raw_opaque_destination_alpha_rules() {
    let initial: Vec<_> = (0..641).map(|index| Color::rgba(index as u8, 19, 211, (index * 17) as u8)).collect();
    for source in [vec![Color::rgba(0, 0, 0, 0); 641], vec![Color::rgba(3, 17, 199, 255); 641]] {
        for opaque in [false, true] { compare_rows(&initial, &source, opaque); }
    }
}

#[test]
fn bitmap_packed_public_copy_pixels_clips_real_short_rows_and_preserves_dirty_output() {
    with_bitmap_context(|context| {
        let (source_width, source_height) = (67usize, 9usize);
        let (dest_width, dest_height) = (73usize, 8usize);
        let source_pixels: Vec<_> = (0..source_width * source_height)
            .map(|index| premultiplied(index, ((index * 37) % 256) as u8)).collect();
        let initial: Vec<_> = (0..dest_width * dest_height)
            .map(|index| Color::rgba((index * 13) as u8, (index * 29) as u8, 201, (index * 7) as u8)).collect();
        for transparent in [false, true] {
            for merge in [false, true] {
                let source = BitmapData::new_with_pixels(context.gc(), source_width as u32, source_height as u32, true, source_pixels.clone());
                let dest = BitmapData::new_with_pixels(context.gc(), dest_width as u32, dest_height as u32, transparent, initial.clone());
                let mut expected = initial.clone();
                for local_y in 0..11i32 {
                    for local_x in 0..71i32 {
                        let (sx, sy, dx, dy) = (-4 + local_x, 1 + local_y, 3 + local_x, -2 + local_y);
                        if sx < 0 || sy < 0 || dx < 0 || dy < 0 || sx >= source_width as i32
                            || sy >= source_height as i32 || dx >= dest_width as i32 || dy >= dest_height as i32 { continue; }
                        let incoming = source_pixels[sx as usize + sy as usize * source_width];
                        let slot = dx as usize + dy as usize * dest_width;
                        expected[slot] = if merge || !transparent { reference(expected[slot], incoming, !transparent) } else { incoming };
                    }
                }
                crate::bitmap::operations::copy_pixels(context, dest, source, (-4, 1, 71, 11), (3, -2), merge);
                let read = dest.read_area(PixelRegion::for_whole_size(dest_width as u32, dest_height as u32), context.renderer);
                assert_eq!(read.raw_pixels(), expected.as_slice(), "transparent={transparent}, merge={merge}");
                assert!(matches!(read.dirty_state(), DirtyState::CpuModified(_)));
            }
        }
    });
}
