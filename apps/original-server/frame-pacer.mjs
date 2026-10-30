/**
 * Advance only after a frame was actually emitted. Small timer lateness stays
 * on the original simulation grid; a longer ACK, join or event-loop stall
 * starts a fresh interval instead of producing catch-up frames.
 */
export function advanceOriginalFrameDeadline(previousDue, emittedAt, frameMs) {
  if (!Number.isFinite(emittedAt) || emittedAt < 0
    || !Number.isFinite(frameMs) || frameMs <= 0
    || (previousDue !== null && (!Number.isFinite(previousDue)
      || previousDue < 0 || emittedAt < previousDue))) {
    throw new RangeError('Invalid original frame pacing clock');
  }
  const jitterBudget = Math.min(frameMs / 8, 5);
  const nextDue = previousDue === null || emittedAt - previousDue > jitterBudget
    ? emittedAt + frameMs : previousDue + frameMs;
  if (!Number.isFinite(nextDue) || nextDue <= emittedAt) {
    throw new RangeError('Original frame pacing clock exhausted');
  }
  return nextDue;
}
