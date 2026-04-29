# Build reproducibility

Reviewer-facing notes for verifying that the `.xpi` shipped to
[addons.thunderbird.net](https://addons.thunderbird.net/) is the
unmodified result of building this repository at a tagged commit. Tracks
[#43](https://github.com/encryption4all/postguard-tb-addon/issues/43).

## What ships in the `.xpi`

Running `npm run package` produces a single ZIP (`*.xpi`) containing only
the contents of `dist/`. There are five JavaScript bundles, three HTML
files, the manifest, locale strings, icons, and a CSS file. There is no
separate `.wasm` file in the package — the WebAssembly binary is
base64-inlined into `dist/pages/yivi-popup/yivi-popup.js` by esbuild at
build time.

## Source of the WebAssembly binary

The WASM module is the published
[`@e4a/pg-wasm`](https://www.npmjs.com/package/@e4a/pg-wasm) npm package.
It is consumed transitively via `@e4a/pg-js` (see
[`package.json`](../package.json) and
[`package-lock.json`](../package-lock.json)).

The npm package is produced by the `publish-wasm` job in
[`encryption4all/postguard`'s
`.github/workflows/delivery.yml`](https://github.com/encryption4all/postguard/blob/main/.github/workflows/delivery.yml)
on every `pg-core` release. That job runs:

```text
# Rust toolchain: dtolnay/rust-toolchain@stable on ubuntu-latest
cargo install wasm-pack
wasm-pack build --release -d pkg/bundler --out-name index --scope e4a --target bundler ./pg-wasm
wasm-pack build --release -d pkg/web     --out-name index --scope e4a --target web     ./pg-wasm
```

`wasm-pack` then invokes `cargo build --release --target wasm32-unknown-unknown`
followed by `wasm-bindgen` and `wasm-opt -Os` (the optimisation flag is
declared in
[`pg-wasm/Cargo.toml`](https://github.com/encryption4all/postguard/blob/main/pg-wasm/Cargo.toml)
under `[package.metadata.wasm-pack.profile.release]`).

## Reproducing the bundled JavaScript

```bash
git clone https://github.com/encryption4all/postguard-tb-addon
cd postguard-tb-addon
git checkout v<X.Y.Z>          # the published add-on version
npm ci                          # respects package-lock.json byte-for-byte
cp .env.example .env            # PKG_URL / CRYPTIFY_URL / POSTGUARD_WEBSITE_URL
npm run build
```

`package-lock.json` pins `@e4a/pg-wasm` to a specific version with an
integrity hash, so `npm ci` will refuse to install a tampered tarball.
At the time of writing this is:

```text
@e4a/pg-wasm@0.5.9
sha512-/K2oDkBVy3pHg4HhWu/UXbnr68ID+MUMsqtO0KwFvfmlQ4EE/sOzRxZgGr2lXCS1zGEwq8c/y2AlsqAP9sd4zg==
```

After `npm ci`, the actual WASM bytes that get inlined are at
`node_modules/@e4a/pg-wasm/bundler/index_bg.wasm`. Compare its
SHA-256 against the version on npm:

```bash
sha256sum node_modules/@e4a/pg-wasm/bundler/index_bg.wasm
# Should match the upstream tarball's bundler/index_bg.wasm.
# To pull the upstream tarball directly:
npm pack @e4a/pg-wasm@<version> --pack-destination /tmp
tar -xzf /tmp/e4a-pg-wasm-<version>.tgz -C /tmp
sha256sum /tmp/package/bundler/index_bg.wasm
```

The two hashes must be identical. If they differ, the local
`node_modules` has been modified after install — investigate before
shipping anything.

## Reproducing the WASM binary from source

This is one extra link removed from the add-on review. It verifies that
the published `@e4a/pg-wasm@X.Y.Z` matches the source in
`encryption4all/postguard`. The CI job above already does this on every
release; a reviewer can re-run it locally:

```bash
git clone https://github.com/encryption4all/postguard
cd postguard
# Match the toolchain CI uses (stable). For full determinism, pin to the
# Rust release current at the pg-wasm publish date — see
# .github/workflows/delivery.yml history.
rustup install stable
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build --release -d pkg/bundler --out-name index --scope e4a --target bundler ./pg-wasm
sha256sum pg-wasm/pkg/bundler/index_bg.wasm
```

This hash should match the npm package's `bundler/index_bg.wasm`.

### Known caveats

- `wasm-pack` and `wasm-bindgen` versions are not currently pinned in
  [`postguard`'s `delivery.yml`](https://github.com/encryption4all/postguard/blob/main/.github/workflows/delivery.yml).
  CI installs the latest via `cargo install wasm-pack`. A reviewer
  running this locally on a different day may get a different
  `wasm-bindgen` and produce a different `index_bg.wasm`. Pinning is
  tracked in
  [encryption4all/postguard#65](https://github.com/encryption4all/postguard/issues/65)
  and
  [encryption4all/postguard#66](https://github.com/encryption4all/postguard/issues/66).
- The published npm `version` field follows `pg-core`'s release
  cadence, which can drift from the `pg-wasm` crate's own `Cargo.toml`
  version. Treat the npm version as authoritative for "which WASM is in
  the `.xpi`".

## Reviewer notes for AMO submissions

When submitting this add-on to addons.thunderbird.net, paste the
following into the *Notes for reviewers* field, with the relevant tag
and hashes filled in:

```text
Source: https://github.com/encryption4all/postguard-tb-addon (tag v<X.Y.Z>)
Build: npm ci && cp .env.example .env && npm run build && npm run package

Embedded WebAssembly:
  Source:  https://github.com/encryption4all/postguard (tag <pg-core release>)
  Package: @e4a/pg-wasm@<version> on npm
  Hash:    sha256:<sha256 of bundler/index_bg.wasm>

Toolchain:
  Node.js >= 20
  Rust stable, target wasm32-unknown-unknown
  wasm-pack (latest at build time)

The .xpi contains no separate .wasm file. The WebAssembly module is
inlined as base64 into dist/pages/yivi-popup/yivi-popup.js by esbuild.

Reproducibility procedure:
  See docs/build-reproducibility.md in the source tree.
```

Update the version, hash, and pg-core tag for each submission.
