# Public V24 Ruffle source package

This directory contains the complete cumulative Boxhead V24 overlay: 127 source
files, a SHA256 manifest, the inherited Rust tests, and Ruffle's MIT/Apache-2.0
license texts. The base is public `ruffle-rs/ruffle` commit
`cac5c99ce4a17e606f4ee3090389bb878f852055`. Vendor licenses remain beside their
sources. No historical build reports or sealed parent artifacts are needed.

The application's default build uses the checked-in optimized bundle in
`public/ruffle/`. Rebuilding this package is a separate, optional native build.
Fresh build dates and toolchains can change asset hashes; this builder does not
promise byte equality with the checked-in bundle or inherit gameplay/FPS results.

## Verify the package

From the repository root, using Python 3.10 or later:

```sh
python3 tools/public-runtime/build.py verify
python3 -m unittest discover -s tools/public-runtime -p 'test_*.py'
```

## Rebuild the runtime

Install Git, Node 22/npm, the Rust toolchain required by upstream's
`rust-toolchain` file, its `wasm32-unknown-unknown` target and `rust-src` component,
and `wasm-bindgen-cli` **0.2.127**. Native JPEG-XR compilation also needs a C/C++
compiler and the upstream WebAssembly C build prerequisites. Binaryen's
`wasm-opt` is optional; its presence affects optimized output bytes. The initial
clone, npm installation and Cargo dependency downloads need network access.

Both source and output locations must be fresh and outside this repository.
For example, run these commands from the repository root:

```sh
python3 tools/public-runtime/build.py prepare --source-root /tmp/boxhead-ruffle-source
cd /tmp/boxhead-ruffle-source
rustup target add wasm32-unknown-unknown
rustup component add rust-src
cargo install wasm-bindgen-cli --version 0.2.127 --locked
cd -
python3 tools/public-runtime/build.py build \
  --source-root /tmp/boxhead-ruffle-source \
  --out /tmp/boxhead-ruffle-build --rust-tests --jobs 4
```

`prepare` verifies a clean pinned upstream checkout, checks every shipped overlay
hash, applies the cumulative source, creates a new public version seal, and
records the full prepared source inventory. `build` verifies that inventory
before and after compilation, builds both SIMD and MVP WASM variants, preserves
licenses, and writes a fresh `build-manifest.json` beside `runtime/`.

With `--rust-tests`, every group must produce its exact reviewed test names and
counts: 440 passing cases in 23 groups, plus one explicitly ignored test. Without
that flag the manifest records no executed Rust groups. Browser, gameplay,
cross-client native agreement and performance qualification remain separate.

Commands write only to the explicitly selected fresh build directories. They do
not replace `public/ruffle/`, deploy a service, change Git remotes or push code.
Review generated source maps and local build logs before publishing rebuilt
assets: toolchains may record their local build directory.

## Source and dependency boundaries

`overlay-manifest.json` lists every final source file and its public package
origin. Five inherited scalar/projection test files supplement the 122-file
smooth engine package. The complete upstream source is obtained at the pinned
commit; npm and Cargo dependencies use upstream's lockfiles. The vendored
`third_party/boxhead-gc-arena/` sources and their licenses are included directly.

Original game SWFs, artwork, audio and decompiled game code have separate
provenance; the Ruffle licenses do not establish rights to those assets.
