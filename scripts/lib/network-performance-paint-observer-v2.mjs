/** Count actual WebGL drawing submissions from the Ruffle canvas between rAF
 * callbacks. This is evidence of renderer work, not proof that a display showed
 * distinct pixels. V2 also timestamps actual successful screen submissions
 * and rAF callback entry, separately from the scheduled rAF timestamp.
 * It never changes a draw argument, result, exception or RNG.
 * Self-contained for use in a browser init script before Ruffle creates WebGL.
 */
export function installNetworkPerformancePaintObserverV2(globalObject, observation, maxIntervals = 120000) {
  const o = observation;
  o.paintSamples = [];
  o.screenSubmissions = [];
  o.screenTiming = { schema: 'boxhead-default-framebuffer-submit-clock-v2', rows: 0, dropped: 0,
    clock: 'performance.now at actual successful default framebuffer draw/color-blit return',
    frameGrouping: 'same observation-rAF bucket; several submissions in one bucket are one frame',
    limitations: 'CPU submission timestamps only; no GPU completion, display scan-out or distinct-pixel proof.' };
  o.paintObservation = { schema: 'boxhead-webgl-paint-observer-v2', backend: 'webgl', wrappedMethods: [], observedContexts: 0,
    actualDrawCalls: 0, actualDefaultFramebufferDrawCalls: 0, actualDefaultFramebufferColorBlits: 0,
    limitations: 'WebGL calls bucketed by rAF. Total draws include offscreen work; default-framebuffer draws/color blits are counted separately using passive binding calls. No GPU/display completion or distinct-pixel proof; no per-call GL error query. WebGPU and OffscreenCanvas are not covered.' };
  const contexts = new WeakSet();
  const observedContexts = [];
  const framebufferBindings = new WeakMap();
  let calls = 0, screenDraws = 0, screenBlits = 0, previous = null, bounded = false;
  let observedPrevious = null, frame = 0, screenBounded = false, clockFailed = false;
  function clock() {
    const at = globalObject.performance.now();
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
      if (!clockFailed) o.errors.push({ type: 'paint_clock_invalid', error: 'Actual browser submission clock is invalid' });
      clockFailed = true;
      return null;
    }
    return at;
  }
  function screen(kind) {
    const at = clock();
    if (at === null) return;
    if (o.screenSubmissions.length >= maxIntervals * 4) {
      o.screenTiming.dropped++;
      if (!screenBounded) o.errors.push({ type: 'screen_timestamp_capacity', error: 'Actual submission timestamp bound exceeded' });
      screenBounded = true;
      return;
    }
    o.screenSubmissions.push({ frame, at, tick: o.tick, kind });
    o.screenTiming.rows++;
  }
  function binding(context) {
    let value = framebufferBindings.get(context);
    if (!value) {
      // The observer is installed before context creation, whose initial
      // read/draw targets are the default framebuffer. Do not consume GL
      // errors or introduce synchronous getParameter calls into rendering.
      value = { draw: null }; framebufferBindings.set(context, value);
      context.canvas?.addEventListener?.('webglcontextrestored', () => { value.draw = null; });
    }
    return value;
  }
  function isRuffleCanvas(canvas) {
    if (!canvas || typeof canvas.getRootNode !== 'function') return false;
    let current = canvas;
    for (let depth = 0; depth < 8; depth++) {
      if (current.id === 'original-ruffle-player') return true;
      if (typeof current.closest === 'function' && current.closest('#original-ruffle-player')) return true;
      const root = current.getRootNode?.();
      if (!root?.host || root.host === current) return false;
      current = root.host;
    }
    return false;
  }
  // Explicitly requested outside the timing window. This reads the actual
  // context used by observed Ruffle drawing, never a diagnostic second canvas.
  // A nonenumerable method is omitted by the normal JSON evidence transfer.
  Object.defineProperty(o, 'readObservedWebGLGPU', { enumerable: false, configurable: false,
    value: function () {
      return { schema: 'boxhead-observed-ruffle-webgl-gpu-v1', observedContexts: o.paintObservation.observedContexts,
        contexts: observedContexts.map((context, index) => {
          const result = { index: index + 1, active: false, contextLost: null, version: null, vendor: null, renderer: null,
            unmaskedVendor: null, unmaskedRenderer: null, debugRendererInfoAvailable: false, errors: [] };
          try {
            result.contextLost = typeof context.isContextLost === 'function' ? context.isContextLost() : null;
            result.active = result.contextLost === false;
            result.version = context.getParameter(0x1f02);
            result.vendor = context.getParameter(0x1f00);
            result.renderer = context.getParameter(0x1f01);
            const extension = context.getExtension('WEBGL_debug_renderer_info');
            result.debugRendererInfoAvailable = Boolean(extension);
            if (extension) {
              result.unmaskedVendor = context.getParameter(extension.UNMASKED_VENDOR_WEBGL);
              result.unmaskedRenderer = context.getParameter(extension.UNMASKED_RENDERER_WEBGL);
            }
          } catch (error) { result.errors.push(String(error)); }
          return result;
        }),
        limits: 'Explicit read-only query of already observed Ruffle WebGL contexts; driver strings are not GPU/display completion or a frame-rate measurement.' };
    } });
  for (const type of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const prototype = globalObject[type]?.prototype;
    if (!prototype) continue;
    for (const name of ['bindFramebuffer', 'deleteFramebuffer', 'blitFramebuffer',
      'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = prototype[name];
      if (typeof original !== 'function') continue;
      // Some browsers inherit an already wrapped WebGL1 method in WebGL2.
      if (original.__boxheadPaintObserver) continue;
      const wrapped = function (...args) {
        const result = Reflect.apply(original, this, args);
        try {
          const bound = binding(this);
          if (name === 'bindFramebuffer') {
            // FRAMEBUFFER changes both targets; READ_FRAMEBUFFER does not
            // change the output target. GLenum values are fixed by WebGL.
            if (args[0] === 0x8d40 || args[0] === 0x8ca9) bound.draw = args[1] ?? null;
            return result;
          }
          if (name === 'deleteFramebuffer') {
            if (bound.draw === args[0]) bound.draw = null;
            return result;
          }
          if (contexts.has(this) || isRuffleCanvas(this.canvas)) {
            if (!contexts.has(this)) {
              contexts.add(this); o.paintObservation.observedContexts++;
              if (observedContexts.length < 16) observedContexts.push(this);
              else o.errors.push({ type: 'paint_context_capacity', error: 'Observed WebGL context bound exceeded' });
            }
            if (o.tick > 0) {
              if (name === 'blitFramebuffer') {
                if (bound.draw === null && (args[8] & 0x4000)) {
                  screenBlits++; o.paintObservation.actualDefaultFramebufferColorBlits++;
                  screen('color-blit');
                }
              } else {
                calls++; o.paintObservation.actualDrawCalls++;
                if (bound.draw === null) { screenDraws++; o.paintObservation.actualDefaultFramebufferDrawCalls++; screen('draw'); }
              }
            }
          }
        } catch { /* Instrumentation must not change rendering. Missing coverage remains visible. */ }
        return result;
      };
      Object.defineProperty(wrapped, '__boxheadPaintObserver', { value: true });
      try { prototype[name] = wrapped; o.paintObservation.wrappedMethods.push(type + '.' + name); }
      catch { /* Read-only browser prototypes are reported by empty coverage. */ }
    }
  }
  function sample(at) {
    const observedAt = clock();
    if (o.tick > 0 && previous !== null) {
      if (o.paintSamples.length < maxIntervals) o.paintSamples.push({ frame, from: previous, at,
        observedFrom: observedPrevious, observedAt, observedMs: observedAt === null || observedPrevious === null ? null : observedAt - observedPrevious,
        ms: at - previous, tick: o.tick, drawCalls: calls,
        defaultFramebufferDrawCalls: screenDraws, defaultFramebufferColorBlits: screenBlits });
      else if (!bounded) {
        bounded = true;
        o.errors.push({ type: 'paint_evidence_capacity', error: 'Paint interval evidence bound exceeded' });
      }
    }
    calls = 0; screenDraws = 0; screenBlits = 0; previous = o.tick > 0 ? at : null;
    observedPrevious = o.tick > 0 ? observedAt : null; frame++;
    globalObject.requestAnimationFrame(sample);
  }
  globalObject.requestAnimationFrame(sample);
}
