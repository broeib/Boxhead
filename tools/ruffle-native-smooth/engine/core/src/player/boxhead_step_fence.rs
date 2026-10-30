//! Bounded FIFO for ambient entries observed while a full-tick fence is open.
//! No tick is split, merged, counted twice, or converted into a new game step.

use super::*;
use crate::avm1::globals::boxhead_step_fence;
use crate::events::ImeEvent;

const MAX_DEFERRED_ENTRIES: usize = 512;
const MAX_DEFERRED_STRING_BYTES: usize = 65_536;
const MAX_DEFERRED_MILLIS: f64 = 2_000.0;

pub(super) enum Entry {
    Tick(FloatDuration),
    Input(PlayerEvent),
    MouseInStage(bool),
    Viewport(ViewportDimensions),
    Fullscreen(bool),
    RunState(RunState),
    RunFrame,
    Timers(FloatDuration),
    Sockets,
    NetConnections,
    RenderBroadcast,
    Background(Option<Color>),
    Letterbox(Letterbox),
    ShowMenu(bool),
    AllowFullscreen(bool),
    Quality(StageQuality),
    WindowMode(String),
    ScaleMode(StageScaleMode),
    ForcedScaleMode(bool),
    ClearContextMenu,
    PrepareContextMenu,
    ContextMenuCallback(usize),
    Clipboard(String, fn(&mut dyn UiBackend, String)),
}

impl Entry {
    fn string_bytes(&self) -> usize {
        match self {
            Self::Input(PlayerEvent::Ime(ImeEvent::Preedit(text, _) | ImeEvent::Commit(text)))
                | Self::WindowMode(text) | Self::Clipboard(text, _) => text.len(),
            _ => 0,
        }
    }

    fn millis(&self) -> f64 {
        match self { Self::Tick(dt) | Self::Timers(dt) => dt.as_millis(), _ => 0.0 }
    }
}

#[derive(Default)]
pub(super) struct Deferred {
    entries: VecDeque<Entry>,
    string_bytes: usize,
    millis: f64,
    draining: bool,
}

impl Deferred {
    fn push(&mut self, entry: Entry) -> Result<(), &'static str> {
        let bytes = entry.string_bytes();
        let millis = entry.millis();
        if self.entries.len() >= MAX_DEFERRED_ENTRIES { return Err("ambient event queue capacity exceeded"); }
        if bytes > MAX_DEFERRED_STRING_BYTES.saturating_sub(self.string_bytes) {
            return Err("ambient event queue string-byte limit exceeded");
        }
        if !millis.is_finite() || millis < 0.0 || self.millis + millis > MAX_DEFERRED_MILLIS {
            return Err("ambient event queue elapsed-time limit exceeded");
        }
        self.string_bytes += bytes;
        self.millis += millis;
        self.entries.push_back(entry);
        Ok(())
    }

    fn pop(&mut self) -> Option<Entry> {
        let entry = self.entries.pop_front()?;
        self.string_bytes -= entry.string_bytes();
        self.millis = (self.millis - entry.millis()).max(0.0);
        Some(entry)
    }

    fn discard_poisoned(&mut self) {
        self.entries.clear();
        self.string_bytes = 0;
        self.millis = 0.0;
    }
}

impl Player {
    pub(super) fn boxhead_frozen(&self) -> bool {
        self.enter_arena(|_, root, _| root.external_interface.step_fence.frozen())
    }

    pub(super) fn boxhead_poisoned(&self) -> bool {
        self.enter_arena(|_, root, _| root.external_interface.step_fence.poisoned())
    }

    pub(super) fn boxhead_poison(&mut self, reason: &'static str) {
        self.mutate_with_update_context_unchecked(|context| boxhead_step_fence::poison(context, reason));
        self.boxhead_deferred.discard_poisoned();
    }

    /// True means this entry was deferred or the Player is already poisoned.
    /// No original handler has run in either case.
    pub(super) fn boxhead_defer(&mut self, entry: Entry) -> bool {
        if self.boxhead_frozen() {
            if self.boxhead_poisoned() {
                self.boxhead_deferred.discard_poisoned();
            } else if let Err(reason) = self.boxhead_deferred.push(entry) {
                self.boxhead_poison(reason);
            }
            true
        } else {
            self.boxhead_drain();
            self.boxhead_poisoned()
        }
    }

    /// Called only on a subsequent Player entry, never by receipt return.
    /// A valid receipt remains valid; an exceptional backlog poisons the next
    /// transaction before its ACK instead of silently losing or reordering VM
    /// work. The drain is bounded by entry count, not elapsed wall time: legal
    /// original handlers, GC or OS scheduling can exceed a frame budget. Each
    /// original handler retains the normal execution timeout.
    pub(super) fn boxhead_drain(&mut self) {
        let _gc_turn = self.boxhead_gc_enter();
        if self.boxhead_deferred.draining || self.boxhead_deferred.entries.is_empty() || self.boxhead_frozen() { return; }
        self.boxhead_deferred.draining = true;
        let mut count = 0;
        while !self.boxhead_deferred.entries.is_empty() {
            if count >= MAX_DEFERRED_ENTRIES {
                self.boxhead_poison("ambient event drain exceeded its entry limit");
                break;
            }
            let entry = self.boxhead_deferred.pop().unwrap();
            match entry {
                Entry::Tick(dt) => self.tick(dt),
                Entry::Input(event) => { self.handle_event(event); }
                Entry::MouseInStage(value) => self.set_mouse_in_stage(value),
                Entry::Viewport(value) => self.set_viewport_dimensions(value),
                Entry::Fullscreen(value) => self.set_fullscreen(value),
                Entry::RunState(value) => self.set_run_state(value),
                Entry::RunFrame => self.run_frame(),
                Entry::Timers(dt) => self.update_timers(dt),
                Entry::Sockets => self.update_sockets(),
                Entry::NetConnections => self.update_net_connections(),
                Entry::RenderBroadcast => self.update(|context| {
                    let stage = context.stage;
                    stage.broadcast_render(context);
                }),
                Entry::Background(value) => self.set_background_color(value),
                Entry::Letterbox(value) => self.set_letterbox(value),
                Entry::ShowMenu(value) => self.set_show_menu(value),
                Entry::AllowFullscreen(value) => self.set_allow_fullscreen(value),
                Entry::Quality(value) => self.set_quality(value),
                Entry::WindowMode(value) => self.set_window_mode(&value),
                Entry::ScaleMode(value) => self.set_scale_mode(value),
                Entry::ForcedScaleMode(value) => self.set_forced_scale_mode(value),
                Entry::ClearContextMenu => self.clear_custom_menu_items(),
                Entry::PrepareContextMenu => { self.prepare_context_menu(); }
                Entry::ContextMenuCallback(index) => self.run_context_menu_callback(index),
                Entry::Clipboard(text, setter) => self.set_clipboard_content_buffer(text, setter),
            }
            count += 1;
            if self.boxhead_frozen() {
                self.boxhead_poison("ambient callback tried opening another staged transaction during drain");
                break;
            }
        }
        self.boxhead_deferred.draining = false;
        self.boxhead_gc_service();
    }

    /// Arbitrary asynchronous loader closures have arbitrary captured values,
    /// lifetimes and return types. Running them would mutate the fenced world;
    /// pretending success or dropping them would hide work. Known ambient
    /// entries above are queued. Unexpected opaque mutation fails closed before
    /// the closure executes, and the caller must dispose this poisoned Player.
    pub(super) fn boxhead_require_ambient(&mut self) {
        self.boxhead_drain();
        if self.boxhead_frozen() {
            self.boxhead_poison("unexpected asynchronous VM mutation during a staged tick");
            panic!("Boxhead staged tick: unexpected asynchronous VM mutation; Player must be disposed");
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod compact_tests;

#[cfg(test)]
mod gc_tests;
