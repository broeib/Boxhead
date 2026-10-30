//! Collector differential tests use the unchanged public Arena methods as
//! their independent oracle. No browser clock, forced game step or GC debt
//! adjustment is introduced in production by these fixtures.

use super::*;
use gc_arena::{Arena, Collect, Gc, GcWeak, RefLock, Rootable};
use gc_arena::arena::CollectionPhase;
use gc_arena::collect::Trace;
use gc_arena::metrics::Pacing;
use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};

#[derive(Clone)]
struct Tracked {
    id: u32,
    drops: Rc<RefCell<Vec<u32>>>,
}
gc_arena::static_collect!(Tracked);
impl Drop for Tracked {
    fn drop(&mut self) {
        self.drops.borrow_mut().push(self.id);
    }
}

#[derive(Collect)]
#[collect(no_drop)]
struct Fixture<'gc> {
    strong: Gc<'gc, RefLock<Vec<Gc<'gc, Tracked>>>>,
    weak: Vec<GcWeak<'gc, Tracked>>,
}
type FixtureArena = Arena<Rootable![Fixture<'_>]>;

fn fixture(count: u32) -> (FixtureArena, Rc<RefCell<Vec<u32>>>) {
    let drops = Rc::new(RefCell::new(Vec::new()));
    let arena = Arena::<Rootable![Fixture<'_>]>::new(|mc| {
        let strong = Gc::new(mc, RefLock::new(Vec::new()));
        let mut weak = Vec::new();
        for id in 0..count {
            let value = Gc::new(mc, Tracked { id, drops: Rc::clone(&drops) });
            weak.push(Gc::downgrade(value));
            if id % 3 == 0 {
                strong.unlock(mc).borrow_mut().push(value);
            }
        }
        Fixture { strong, weak }
    });
    (arena, drops)
}

fn snapshot(arena: &FixtureArena) -> (usize, f64, CollectionPhase, Vec<Option<u32>>) {
    (
        arena.metrics().total_gc_count(),
        arena.metrics().allocation_debt(),
        arena.collection_phase(),
        arena.mutate(|mc, root| root.weak.iter().map(|weak| weak.upgrade(mc).map(|value| value.id)).collect()),
    )
}

fn repay<R>(arena: &mut Arena<R>, cap: usize)
where
    R: for<'gc> gc_arena::arena::Rootable<'gc>,
    for<'gc> gc_arena::arena::Root<'gc, R>: Collect<'gc>,
{
    for _ in 0..100_000 {
        if arena.metrics().allocation_debt() == 0.0 {
            return;
        }
        let completed = arena.collect_debt_slice(cap, |_| true);
        assert!(completed > 0 && completed <= cap);
    }
    panic!("bounded collector failed to make progress");
}

#[test]
fn gc_slice_zero_work_and_rejected_budget_leave_phase_debt_and_objects_untouched() {
    let (mut arena, drops) = fixture(513);
    let before = snapshot(&arena);
    let callbacks = Cell::new(0);
    assert_eq!(arena.collect_debt_slice(0, |_| { callbacks.set(callbacks.get() + 1); true }), 0);
    assert_eq!(callbacks.get(), 0);
    assert_eq!(snapshot(&arena), before);
    assert_eq!(arena.collect_debt_slice(123, |_| false), 0);
    assert_eq!(snapshot(&arena), before);
    assert!(drops.borrow().is_empty());
}

#[test]
fn gc_slice_no_debt_does_not_call_budget_or_change_sleep_state() {
    let mut arena = Arena::<Rootable![()]>::new(|_| ());
    assert_eq!(arena.metrics().allocation_debt(), 0.0);
    assert_eq!(arena.collect_debt_slice(usize::MAX, |_| panic!("zero debt must not probe")), 0);
    assert_eq!(arena.collection_phase(), CollectionPhase::Sleeping);
}

#[test]
fn gc_slice_unlimited_matches_original_public_api_from_each_collection_phase() {
    for setup in 0..5 {
        let (mut original, original_drops) = fixture(513);
        let (mut sliced, sliced_drops) = fixture(513);
        for arena in [&mut original, &mut sliced] {
            match setup {
                0 => {}
                1 => {
                    arena.metrics().set_pacing(Pacing { sleep_factor: 0.0, min_sleep: 0, ..Pacing::DEFAULT });
                    arena.finish_cycle();
                    arena.metrics().adjust_debt(0.25);
                    drop(arena.mark_debt());
                    assert_eq!(arena.collection_phase(), CollectionPhase::Marking);
                    arena.metrics().adjust_debt(4096.0);
                }
                2 => { drop(arena.finish_marking()); }
                3 => { arena.finish_marking().unwrap().start_sweeping(); }
                4 => {
                    arena.finish_cycle();
                    arena.mutate(|mc, root| root.strong.unlock(mc).borrow_mut().clear());
                    arena.metrics().adjust_debt(4096.0);
                }
                _ => unreachable!(),
            }
        }
        assert_eq!(snapshot(&original), snapshot(&sliced));
        original.collect_debt();
        sliced.collect_debt_slice(usize::MAX, |_| true);
        assert_eq!(snapshot(&original), snapshot(&sliced), "setup {setup}");
        assert_eq!(*original_drops.borrow(), *sliced_drops.borrow(), "setup {setup}");
    }
}

#[test]
fn gc_slice_small_caps_eventually_match_original_roots_weak_liveness_and_drop_order() {
    for cap in [1, 2, 3, 31, 32, 33, 63, 64, 65, 257] {
        let (mut original, original_drops) = fixture(513);
        let (mut sliced, sliced_drops) = fixture(513);
        original.collect_debt();
        repay(&mut sliced, cap);
        // A yielded call is incremental and may finish its debt in a different
        // phase. Finish both cycles before comparing externally visible roots.
        original.finish_cycle();
        sliced.finish_cycle();
        assert_eq!(snapshot(&original).0, snapshot(&sliced).0, "cap {cap}");
        assert_eq!(snapshot(&original).3, snapshot(&sliced).3, "cap {cap}");
        assert_eq!(*original_drops.borrow(), *sliced_drops.borrow(), "cap {cap}");
        assert_eq!(sliced_drops.borrow().len(), 342);
        for arena in [&mut original, &mut sliced] {
            arena.mutate_root(|mc, root| {
                root.strong.unlock(mc).borrow_mut().clear();
                root.weak.clear();
            });
            arena.finish_cycle();
        }
        assert_eq!(original.metrics().total_gc_count(), 1);
        assert_eq!(sliced.metrics().total_gc_count(), 1);
        assert_eq!(*original_drops.borrow(), *sliced_drops.borrow());
        assert_eq!(sliced_drops.borrow().len(), 513);
    }
}

#[test]
fn gc_slice_interrupted_sweep_preserves_carried_debt_after_empty_heap_and_new_allocation() {
    let make = || {
        let drops = Rc::new(RefCell::new(Vec::new()));
        let mut arena = Arena::<Rootable![()]>::new(|mc| {
            for id in 0..400 { Gc::new(mc, Tracked { id, drops: Rc::clone(&drops) }); }
        });
        arena.metrics().adjust_debt(1000.0);
        arena.finish_marking().unwrap().start_sweeping();
        (arena, drops)
    };
    let (mut original, original_drops) = make();
    let (mut sliced, sliced_drops) = make();
    original.cycle_debt();
    // Debt is reported as zero as soon as the last object is freed. Both APIs
    // therefore stop before the empty sweep list's completion transition.
    assert_eq!(sliced.collect_debt_slice(401, |_| true), 400);
    assert_eq!(original.collection_phase(), CollectionPhase::Sweeping);
    assert_eq!(sliced.collection_phase(), CollectionPhase::Sweeping);
    assert_eq!(sliced.metrics().total_gc_count(), 0);
    assert_eq!(*original_drops.borrow(), *sliced_drops.borrow());
    for arena in [&mut original, &mut sliced] {
        arena.mutate(|mc, _| { Gc::new(mc, 17_u32); });
    }
    original.cycle_debt();
    assert_eq!(sliced.collect_debt_slice(1, |_| true), 1);
    assert_eq!(original.collection_phase(), CollectionPhase::Sleeping);
    assert_eq!(sliced.collection_phase(), CollectionPhase::Sleeping);
    // The resumed incomplete cycle carries1201 debt (including the fresh
    // allocation) and installs the original minimum sleep256.
    assert!((original.metrics().allocation_debt() - 945.0).abs() < 0.000_001);
    assert_eq!(original.metrics().allocation_debt(), sliced.metrics().allocation_debt());
}

#[test]
fn gc_slice_atomic_full_cycle_retains_original_debt_reset() {
    let make = || Arena::<Rootable![Gc<'_, u32>]>::new(|mc| {
        for id in 0..400 { Gc::new(mc, id); }
        mc.metrics().adjust_debt(1000.0);
        // Keep a real allocation rooted so zero-total-Gc debt suppression
        // cannot stop either API before the atomic cycle completion branch.
        Gc::new(mc, 91_u32)
    });
    let mut original = make();
    let mut sliced = make();
    original.collect_debt();
    sliced.collect_debt_slice(usize::MAX, |_| true);
    assert_eq!(original.collection_phase(), CollectionPhase::Sleeping);
    assert_eq!(sliced.collection_phase(), CollectionPhase::Sleeping);
    for arena in [&mut original, &mut sliced] {
        arena.mutate(|mc, _| { Gc::new(mc, 17_u32); });
    }
    assert_eq!(original.metrics().allocation_debt(), 0.0);
    assert_eq!(original.metrics().allocation_debt(), sliced.metrics().allocation_debt());
}

#[derive(Collect)]
#[collect(no_drop)]
struct MutableFixture<'gc> {
    strong: Gc<'gc, RefLock<Option<Gc<'gc, Tracked>>>>,
    weak: Gc<'gc, RefLock<Option<GcWeak<'gc, Tracked>>>>,
}

#[test]
fn gc_slice_backward_barrier_retraces_black_owner_and_keeps_fresh_child() {
    let drops = Rc::new(RefCell::new(Vec::new()));
    let mut arena = Arena::<Rootable![MutableFixture<'_>]>::new(|mc| MutableFixture {
        strong: Gc::new(mc, RefLock::new(None)),
        weak: Gc::new(mc, RefLock::new(None)),
    });
    drop(arena.finish_marking());
    assert_eq!(arena.collection_phase(), CollectionPhase::Marked);
    arena.mutate(|mc, root| {
        let child = Gc::new(mc, Tracked { id: 77, drops: Rc::clone(&drops) });
        *root.strong.unlock(mc).borrow_mut() = Some(child);
        *root.weak.unlock(mc).borrow_mut() = Some(Gc::downgrade(child));
    });
    assert_eq!(arena.collection_phase(), CollectionPhase::Marking);
    arena.metrics().adjust_debt(4096.0);
    repay(&mut arena, 1);
    arena.finish_cycle();
    assert!(drops.borrow().is_empty());
    arena.mutate(|mc, root| {
        let kept = root.weak.borrow().unwrap().upgrade(mc).unwrap();
        assert!(Gc::ptr_eq(kept, root.strong.borrow().unwrap()));
        assert_eq!(kept.id, 77);
        *root.strong.unlock(mc).borrow_mut() = None;
    });
    arena.metrics().adjust_debt(4096.0);
    repay(&mut arena, 2);
    arena.finish_cycle();
    assert_eq!(&*drops.borrow(), &[77]);
    arena.mutate(|mc, root| assert!(root.weak.borrow().unwrap().upgrade(mc).is_none()));
}

#[test]
fn gc_slice_allocations_during_sweep_survive_until_the_next_mark_cycle() {
    let drops = Rc::new(RefCell::new(Vec::new()));
    let mut arena = Arena::<Rootable![MutableFixture<'_>]>::new(|mc| MutableFixture {
        strong: Gc::new(mc, RefLock::new(None)),
        weak: Gc::new(mc, RefLock::new(None)),
    });
    arena.metrics().adjust_debt(4096.0);
    arena.finish_marking().unwrap().start_sweeping();
    arena.mutate(|mc, root| {
        let fresh = Gc::new(mc, Tracked { id: 91, drops: Rc::clone(&drops) });
        *root.weak.unlock(mc).borrow_mut() = Some(Gc::downgrade(fresh));
        assert_eq!(root.weak.borrow().unwrap().upgrade(mc).unwrap().id, 91);
    });
    for _ in 0..100 {
        if arena.collection_phase() == CollectionPhase::Sleeping { break; }
        assert_eq!(arena.collect_debt_slice(1, |_| true), 1);
    }
    assert_eq!(arena.collection_phase(), CollectionPhase::Sleeping);
    assert!(drops.borrow().is_empty());
    arena.mutate(|mc, root| assert_eq!(root.weak.borrow().unwrap().upgrade(mc).unwrap().id, 91));
    arena.finish_cycle();
    assert_eq!(&*drops.borrow(), &[91]);
    arena.mutate(|mc, root| assert!(root.weak.borrow().unwrap().upgrade(mc).is_none()));
    assert_eq!(arena.metrics().total_gc_count(), 3);
    arena.mutate(|mc, root| *root.weak.unlock(mc).borrow_mut() = None);
    arena.finish_cycle();
    assert_eq!(arena.metrics().total_gc_count(), 2);
}

struct TraceProbe<'gc> {
    children: Vec<Gc<'gc, Tracked>>,
    fail_once: Rc<Cell<bool>>,
    continue_budget: Rc<Cell<bool>>,
    traced: Rc<Cell<usize>>,
}
// Safety: every GC child is traced; the remaining fields are static owned
// observation cells with no GC pointers. There is no custom destructor or
// interior adoption of a GC reference.
unsafe impl<'gc> Collect<'gc> for TraceProbe<'gc> {
    fn trace<T: Trace<'gc>>(&self, tracer: &mut T) {
        if self.fail_once.replace(false) { panic!("expected trace failure"); }
        self.continue_budget.set(false);
        for child in &self.children { child.trace(tracer); }
        self.traced.set(self.traced.get() + 1);
    }
}

#[test]
fn gc_slice_budget_expiring_inside_trace_never_splits_the_object_trace() {
    let drops = Rc::new(RefCell::new(Vec::new()));
    let continue_budget = Rc::new(Cell::new(true));
    let traced = Rc::new(Cell::new(0));
    let mut arena = Arena::<Rootable![Gc<'_, TraceProbe<'_>>]>::new(|mc| {
        let children = (0..64).map(|id| Gc::new(mc, Tracked { id, drops: Rc::clone(&drops) })).collect();
        Gc::new(mc, TraceProbe { children, fail_once: Rc::new(Cell::new(false)), continue_budget: Rc::clone(&continue_budget), traced: Rc::clone(&traced) })
    });
    let completed = arena.collect_debt_slice(100, |_| continue_budget.get());
    assert_eq!(completed, 3); // Sleep transition, root, complete TraceProbe.
    assert_eq!(traced.get(), 1);
    assert!(!continue_budget.get());
    assert!(drops.borrow().is_empty());
    arena.finish_cycle();
    arena.mutate(|_, root| assert_eq!(root.children.iter().map(|child| child.id).collect::<Vec<_>>(), (0..64).collect::<Vec<_>>()));
    assert!(drops.borrow().is_empty());
}

#[test]
fn gc_slice_panicking_trace_is_requeued_before_an_old_api_resumes_collection() {
    let drops = Rc::new(RefCell::new(Vec::new()));
    let traced = Rc::new(Cell::new(0));
    let mut arena = Arena::<Rootable![Gc<'_, TraceProbe<'_>>]>::new(|mc| {
        Gc::new(mc, TraceProbe {
            children: vec![Gc::new(mc, Tracked { id: 44, drops: Rc::clone(&drops) })],
            fail_once: Rc::new(Cell::new(true)), continue_budget: Rc::new(Cell::new(true)), traced: Rc::clone(&traced),
        })
    });
    assert!(catch_unwind(AssertUnwindSafe(|| arena.collect_debt_slice(100, |_| true))).is_err());
    assert_eq!(traced.get(), 0);
    arena.finish_cycle();
    assert_eq!(traced.get(), 1);
    assert!(drops.borrow().is_empty());
    arena.mutate(|_, root| assert_eq!(root.children[0].id, 44));
}

#[test]
fn gc_slice_panicking_budget_callback_leaves_a_resumable_collector() {
    let (mut arena, drops) = fixture(513);
    assert!(catch_unwind(AssertUnwindSafe(|| {
        arena.collect_debt_slice(100, |completed| {
            if completed == 2 { panic!("expected budget failure"); }
            true
        });
    })).is_err());
    arena.collect_debt();
    arena.finish_cycle();
    assert_eq!(drops.borrow().len(), 342);
    arena.mutate(|mc, root| {
        for (index, weak) in root.weak.iter().enumerate() {
            assert_eq!(weak.upgrade(mc).map(|value| value.id), if index % 3 == 0 { Some(index as u32) } else { None });
        }
    });
}

#[derive(Collect)]
#[collect(no_drop)]
struct ChurnRoot<'gc> {
    strong: Gc<'gc, RefLock<Vec<Option<Gc<'gc, Tracked>>>>>,
    weak: Gc<'gc, RefLock<Vec<GcWeak<'gc, Tracked>>>>,
}

#[test]
fn gc_slice_sustained_allocation_and_barrier_churn_keeps_bounded_live_count_and_releases_all() {
    const ROUNDS: u32 = 300;
    const PER_ROUND: u32 = 64;
    let drops = Rc::new(RefCell::new(Vec::new()));
    let mut arena = Arena::<Rootable![ChurnRoot<'_>]>::new(|mc| ChurnRoot {
        strong: Gc::new(mc, RefLock::new(vec![None; 32])),
        weak: Gc::new(mc, RefLock::new(Vec::new())),
    });
    let mut largest_retained = 0;
    let mut saw_marking_boundary = false;
    for round in 0..ROUNDS {
        arena.mutate(|mc, root| {
            // These are real barriered mutations of the same owners, not
            // replacement arenas or a retained list of every allocated value.
            let mut strong = root.strong.unlock(mc).borrow_mut();
            let mut weak = root.weak.unlock(mc).borrow_mut();
            weak.clear();
            for offset in 0..PER_ROUND {
                let child = Gc::new(mc, Tracked { id: round * PER_ROUND + offset, drops: Rc::clone(&drops) });
                weak.push(Gc::downgrade(child));
                strong[offset as usize % 32] = Some(child);
            }
        });
        largest_retained = largest_retained.max(arena.metrics().total_gc_count());
        // Periodic single-unit yields deliberately expose marking to the next
        // mutation. Other slices provide bounded throughput, never a forced
        // full collection during the sustained workload.
        let cap = if round % 3 == 0 { 1 } else { 512 };
        let work = arena.collect_debt_slice(cap, |_| true);
        assert!(work <= cap);
        saw_marking_boundary |= arena.collection_phase() == CollectionPhase::Marking;
        arena.mutate(|mc, root| {
            for (index, strong) in root.strong.borrow().iter().enumerate() {
                let strong = strong.unwrap();
                assert_eq!(strong.id, round * PER_ROUND + 32 + index as u32);
                let weak = root.weak.borrow()[32 + index].upgrade(mc).unwrap();
                assert!(Gc::ptr_eq(strong, weak));
            }
        });
    }
    assert!(saw_marking_boundary);
    assert!(largest_retained <= 1024, "unbounded retained heap: {largest_retained}");
    arena.mutate(|mc, root| {
        root.strong.unlock(mc).borrow_mut().clear();
        root.weak.unlock(mc).borrow_mut().clear();
    });
    // A fresh full cycle also sees values allocated during an older sweep.
    arena.finish_cycle();
    arena.finish_cycle();
    assert_eq!(arena.metrics().total_gc_count(), 2);
    let mut dropped = drops.borrow().clone();
    dropped.sort_unstable();
    assert_eq!(dropped, (0..ROUNDS * PER_ROUND).collect::<Vec<_>>());
}

#[test]
fn gc_slice_nested_entries_share_time_and_work_without_resetting_the_outer_allowance() {
    let scheduler = Scheduler::default();
    let outer = scheduler.enter(true).unwrap();
    scheduler.account(100, Duration::from_micros(600));
    {
        let _nested = scheduler.enter(true).unwrap();
        assert_eq!(scheduler.remaining(), Some((Duration::from_micros(400), MAX_WORK - 100)));
        scheduler.account(200, Duration::from_micros(400));
        assert_eq!(scheduler.remaining(), None);
    }
    assert_eq!(scheduler.remaining(), None);
    assert_eq!(scheduler.state.get().depth, 1);
    drop(outer);
    let _next = scheduler.enter(true).unwrap();
    assert_eq!(scheduler.remaining(), Some((ALLOWANCE, MAX_WORK)));
}

#[test]
fn gc_slice_finite_work_cap_and_indivisible_time_overrun_remain_exhausted() {
    let scheduler = Scheduler::default();
    {
        let _turn = scheduler.enter(true).unwrap();
        scheduler.account(MAX_WORK, Duration::ZERO);
        assert_eq!(scheduler.remaining(), None);
        let _nested = scheduler.enter(true).unwrap();
        assert_eq!(scheduler.remaining(), None);
    }
    let _next = scheduler.enter(true).unwrap();
    scheduler.account(1, Duration::from_millis(3));
    assert_eq!(scheduler.state.get().spent, Duration::from_millis(3));
    assert_eq!(scheduler.remaining(), None);
}

#[test]
fn gc_slice_non_collection_game_time_does_not_consume_the_collector_allowance() {
    let scheduler = Scheduler::default();
    let _turn = scheduler.enter(true).unwrap();
    std::thread::sleep(Duration::from_millis(12));
    assert_eq!(scheduler.remaining(), Some((ALLOWANCE, MAX_WORK)));
    scheduler.account(13, Duration::from_micros(125));
    std::thread::sleep(Duration::from_millis(2));
    assert_eq!(scheduler.remaining(), Some((Duration::from_micros(875), MAX_WORK - 13)));
}

#[test]
fn gc_slice_unwind_restores_nested_entry_depth_without_losing_the_next_budget() {
    let scheduler = Scheduler::default();
    assert!(catch_unwind(AssertUnwindSafe(|| {
        let _outer = scheduler.enter(true).unwrap();
        let _nested = scheduler.enter(true).unwrap();
        scheduler.account(11, Duration::from_micros(900));
        panic!("expected host-entry failure");
    })).is_err());
    assert!(!scheduler.active());
    assert_eq!(scheduler.remaining(), None);
    let _next = scheduler.enter(true).unwrap();
    assert_eq!(scheduler.remaining(), Some((ALLOWANCE, MAX_WORK)));
}

#[test]
fn gc_slice_uninstalled_player_keeps_the_original_full_debt_collection() {
    let handle = crate::player::PlayerBuilder::new().build();
    let mut player = handle.lock().unwrap();
    player.gc_arena.borrow().metrics().adjust_debt(100_000.0);
    let before = player.gc_arena.borrow().metrics().allocation_debt();
    assert!(before > 0.0);
    player.boxhead_gc_service();
    assert_eq!(player.gc_arena.borrow().metrics().allocation_debt(), before);
    assert!(!player.boxhead_gc.active());
    player.update(|_| ());
    assert_eq!(player.gc_arena.borrow().metrics().allocation_debt(), 0.0);
    assert!(!player.boxhead_gc.active());
}
