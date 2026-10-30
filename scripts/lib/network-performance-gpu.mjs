// Hardware mode is an explicit evidence gate. Launch flags alone do not prove
// that Ruffle used a hardware context, and a second diagnostic canvas would
// not establish the renderer used by the measured game.
// Hardware measurements require headed Chromium and an available X11 DISPLAY
// (for example, an isolated Xvfb owned by the test runner). Headless Vulkan
// without a surface can retain hardware WebGL while losing GPU compositing.
const commonArgs = ['--no-sandbox', '--disable-dev-shm-usage'];
const autoplayArg = '--autoplay-policy=no-user-gesture-required';
const softwareRenderer = /swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic (?:render|display)|\bwarp\b/i;
const knownHardwareRenderer = /\b(?:AMD|ATI|Radeon|RADV|NVIDIA|GeForce|Quadro|Intel|Iris|Mali|Adreno|Apple|PowerVR)\b/i;
const enabledFeature = value => value === 'enabled' || value === 'enabled_on';
const normalizeRenderer = value => typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, '') : '';

function matchRuffleRenderer(context, gpu, adapters) {
  const actual = normalizeRenderer(context.unmaskedRenderer);
  const cdp = normalizeRenderer(gpu?.auxAttributes?.glRenderer);
  if (actual && actual === cdp) return { comparison: 'exact' };
  // The recorded AMD probe exposes "radv-25.2.8" through CDP and "radv"
  // through WEBGL_debug_renderer_info. Normalize only that terminal suffix,
  // with its exact version corroborated by the same CDP adapter. Do not strip
  // arbitrary renderer versions, device identifiers, vendors or driver names.
  if (!cdp.startsWith('angle(amd,vulkan') || !actual.startsWith('angle(amd,vulkan')) return null;
  const deviceIds = [...cdp.matchAll(/\(0x([0-9a-f]{4,8})\)/g)];
  if (deviceIds.length !== 1) return null;
  const deviceId = Number.parseInt(deviceIds[0][1], 16);
  const vendor = normalizeRenderer(gpu?.auxAttributes?.glVendor);
  if (!vendor || vendor !== normalizeRenderer(context.unmaskedVendor)) return null;
  for (const adapter of adapters) {
    const version = adapter.driverVersion;
    if (adapter.vendorId !== 0x1002 || adapter.deviceId !== deviceId
      || normalizeRenderer(adapter.driverVendor) !== 'amd'
      || normalizeRenderer(adapter.vendorString) !== vendor
      || normalizeRenderer(adapter.deviceString) !== cdp
      || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) continue;
    const suffix = ',radv-' + version + ')';
    if (cdp.endsWith(suffix) && actual === cdp.slice(0, -suffix.length) + ',radv)')
      return { comparison: 'documented-radv-driver-version-suffix', driverVersion: version,
        vendorId: adapter.vendorId, deviceId: adapter.deviceId };
  }
  return null;
}

export function networkPerformanceBrowserArgs(mode) {
  if (mode === 'software') return [...commonArgs, '--enable-unsafe-swiftshader', autoplayArg];
  if (mode === 'hardware') return [...commonArgs, '--enable-gpu', '--use-angle=vulkan',
    '--enable-features=Vulkan', '--ozone-platform=x11', autoplayArg];
  throw new Error('--gpu must be software or hardware');
}

export function inspectHardwareGpuWitness(gpu, observed) {
  const problems = [];
  const rendererMatches = [];
  const renderer = gpu?.auxAttributes?.glRenderer;
  const devices = Array.isArray(gpu?.devices) ? gpu.devices : [];
  const contexts = Array.isArray(observed?.contexts) ? observed.contexts : [];
  if (typeof renderer !== 'string' || !renderer.trim()) problems.push('CDP reports no GL renderer');
  else if (softwareRenderer.test(renderer) || !knownHardwareRenderer.test(renderer))
    problems.push('CDP GL renderer is software or unrecognized');
  const adapters = devices.filter(device => Number.isInteger(device.vendorId) && device.vendorId > 0
    && device.vendorId !== 0xffff && device.vendorId !== 0x1ae0
    && Number.isInteger(device.deviceId) && device.deviceId > 0 && device.deviceId !== 0xffff
    && !softwareRenderer.test(String(device.deviceString ?? '')));
  if (!adapters.length) problems.push('CDP reports no identifiable hardware adapter');
  for (const feature of ['gpu_compositing', 'webgl', 'vulkan']) {
    if (!enabledFeature(gpu?.featureStatus?.[feature])) problems.push('CDP feature is not hardware enabled: ' + feature);
  }
  if (observed?.schema !== 'boxhead-observed-ruffle-webgl-gpu-v1') problems.push('Actual Ruffle context witness is missing');
  if (!contexts.length || observed?.observedContexts !== contexts.length)
    problems.push('Actual Ruffle context coverage is empty or incomplete');
  for (const context of contexts) {
    const label = 'Ruffle context ' + context.index;
    if (context.active !== true || context.contextLost !== false) problems.push(label + ' is not active');
    if (!Array.isArray(context.errors) || context.errors.length) problems.push(label + ' diagnostic failed');
    const actual = context.unmaskedRenderer;
    if (context.debugRendererInfoAvailable !== true || typeof actual !== 'string' || !actual.trim())
      problems.push(label + ' has no unmasked renderer');
    else {
      if (softwareRenderer.test(actual) || !knownHardwareRenderer.test(actual))
        problems.push(label + ' uses a software or unrecognized renderer');
      const match = matchRuffleRenderer(context, gpu, adapters);
      if (!match) problems.push(label + ' renderer does not match the CDP renderer');
      else rendererMatches.push({ context: context.index, ...match });
    }
  }
  return { pass: problems.length === 0, problems, observedContexts: contexts.length,
    rendererMatches,
    renderer: renderer ?? null, adapterIds: adapters.map(device => ({ vendorId: device.vendorId, deviceId: device.deviceId })),
    scope: 'Driver-reported hardware backend of actual observed Ruffle WebGL contexts, corroborated by CDP adapters and enabled features. This does not prove GPU completion, distinct pixels, or monitor scan-out.' };
}

export function compareHardwareGpuWitnesses(before, after) {
  const signature = witness => JSON.stringify({ renderer: normalizeRenderer(witness?.renderer),
    observedContexts: witness?.observedContexts, adapterIds: witness?.adapterIds });
  return before?.pass === true && after?.pass === true && signature(before) === signature(after);
}
