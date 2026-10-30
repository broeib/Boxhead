//! Cooperative GC for the privately installed Boxhead runtime.
//!
//! The allowance measures only time spent in the collector. Game callbacks,
//! FIFO handlers, marshalling, rendering and task waits do not consume it.
//! Owned guards share one allowance across nested Player entries and restore
//! depth on early return or panic, without retaining any GC reference.

use super::Player;
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;
use web_time::Instant;

const ALLOWANCE: Duration = Duration::from_millis(1);
const MAX_WORK: usize = 65_536;
const CLOCK_INTERVAL: usize = 32;

#[derive(Clone, Copy, Default)]
struct Budget {
    depth: u32,
    spent: Duration,
    work: usize,
}

#[derive(Default)]
pub(super) struct Scheduler {
    state: Rc<Cell<Budget>>,
}

pub(super) struct Turn {
    state: Rc<Cell<Budget>>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut state = self.state.get();
        debug_assert!(state.depth > 0);
        state.depth -= 1;
        self.state.set(state);
    }
}

impl Scheduler {
    fn active(&self) -> bool {
        self.state.get().depth != 0
    }

    fn enter(&self, enabled: bool) -> Option<Turn> {
        let mut state = self.state.get();
        if state.depth == 0 {
            if !enabled {
                return None;
            }
            state = Budget::default();
        }
        state.depth = state.depth.checked_add(1).expect("GC entry depth overflow");
        self.state.set(state);
        Some(Turn { state: Rc::clone(&self.state) })
    }

    fn remaining(&self) -> Option<(Duration, usize)> {
        let state = self.state.get();
        if state.depth == 0 || state.spent >= ALLOWANCE || state.work >= MAX_WORK {
            return None;
        }
        Some((ALLOWANCE - state.spent, MAX_WORK - state.work))
    }

    fn account(&self, work: usize, elapsed: Duration) {
        let mut state = self.state.get();
        debug_assert!(state.depth > 0);
        debug_assert!(work <= MAX_WORK - state.work);
        state.work += work;
        // Keep the actual overrun visible to the outer scope. No negative
        // remaining budget, debt adjustment, clock compensation or VM error.
        state.spent = state.spent.saturating_add(elapsed);
        self.state.set(state);
    }
}

impl Player {
    pub(super) fn boxhead_gc_enter(&self) -> Option<Turn> {
        // A nested entry keeps the current budget even if the callback has
        // just failed closed. The owned Player is disposed by its host; GC
        // never drains or resumes that poisoned VM.
        let enabled = self.boxhead_gc.active() || self.enter_arena(|_, root, _| {
            root.external_interface.step_fence.collection_enabled()
        });
        self.boxhead_gc.enter(enabled)
    }

    pub(super) fn boxhead_gc_service(&mut self) {
        let _gc_turn = self.boxhead_gc_enter();
        let Some((remaining_time, remaining_work)) = self.boxhead_gc.remaining() else {
            return;
        };
        // This mutable arena borrow is deliberately outside every mutate and
        // ExternalInterface marshalling scope. No unrooted 'gc value escapes
        // those generative closures.
        let mut arena = self.gc_arena.borrow_mut();
        if !(arena.metrics().allocation_debt() > 0.0) {
            return;
        }
        let started = Instant::now();
        let work = arena.collect_debt_slice(remaining_work, |completed| {
            completed % CLOCK_INTERVAL != 0 || started.elapsed() < remaining_time
        });
        let elapsed = started.elapsed();
        drop(arena);
        self.boxhead_gc.account(work, elapsed);
    }

    pub(super) fn boxhead_gc_update(&mut self) {
        // Installation may have happened inside this update, so the scope
        // can become eligible here even if its entry was originally ordinary.
        let _gc_turn = self.boxhead_gc_enter();
        if self.boxhead_gc.active() {
            self.boxhead_gc_service();
        } else {
            // Exact upstream behavior for a Player without the private fence.
            self.gc_arena.borrow_mut().collect_debt();
        }
    }
}

#[cfg(test)]
mod tests;
