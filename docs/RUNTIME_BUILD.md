# Runtime and SWF builds

Normal npm builds use the checked-in original/online SWFs and optimized Ruffle
bundle. `npm run build` verifies the original artwork/code boundaries, typechecks
the client and builds the web/server distribution.

To regenerate only the online SWF, use Java 17+ and `npm run build:swf`. Its
ActionScript patches live in tools/original-bridge. The root original SWF and
public original SWF must stay byte-identical.

The complete cumulative V24 runtime source overlay, licenses and independent
builder are in [tools/public-runtime](../tools/public-runtime/README.md). Verify
that package before using the optional Rust/WASM rebuild workflow. Historical
private build reports are not needed. A new native build must be tested in the
browser; source verification alone does not establish gameplay or frame rates.
