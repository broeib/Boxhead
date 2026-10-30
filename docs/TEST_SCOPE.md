# Public test scope

The public suite covers original SWF integrity and artwork/code boundaries,
bridge and membership behavior, server protocol and lifecycle, replay and
checkpoints, telemetry, custom input, and the browser application's helpers.
Browser scenarios exercise the real original menus and native runtime.

Private deployment reports, long-run research captures, local runtime manifests
and historical qualification archives are deliberately excluded. Their presence
in a private development tree is not a prerequisite for normal public builds.
This public suite does not claim to reproduce every historical performance
qualification, every map or a WAN campaign. Runtime source rebuild verification
is documented separately.

A successful web build does not alone prove native rendering, deterministic
multiplayer or frame-rate performance. Use browser scenarios for those paths,
and report the tested settings, revisions and limitations.

Frozen source fixtures retain their reviewed bytes, line endings and hashes.
Two server-history checks use checked-in source fixtures instead of requiring
private Git objects; their original predecessor/hash assertions are retained.
The clean public checkout passed 518 Node tests and 1001 web tests after a fresh
npm ci, and its optional runtime package passed seven integrity/builder tests.
The full native Rust/WASM toolchain build was not rerun for this publication.
