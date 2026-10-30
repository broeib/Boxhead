/** Keep the native player and synchronization overlay together when resizing. */
export function mountFullscreen(shell: HTMLElement, stage: HTMLElement, button: HTMLButtonElement,
  message: HTMLElement): void {
  let pending = false;
  const update = (): void => {
    const active = document.fullscreenElement === shell;
    const label = button.querySelector('[data-fullscreen-label]') ?? button;
    label.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
    button.setAttribute('aria-pressed', String(active));
    button.disabled = pending || !document.fullscreenEnabled;
  };
  document.addEventListener('fullscreenchange', () => { update(); stage.focus(); });
  button.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    message.textContent = '';
    update();
    try {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch {
      message.textContent = 'Your browser did not allow fullscreen mode.';
    } finally {
      pending = false;
      update();
      stage.focus();
    }
  });
  if (!document.fullscreenEnabled) message.textContent = 'Fullscreen mode is not available in this browser.';
  update();
}
