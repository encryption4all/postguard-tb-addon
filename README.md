# <p align="center"><img src="./img/pg_logo.svg" height="128px" alt="PostGuard" /></p>

> For full documentation, visit [docs.postguard.eu](https://docs.postguard.eu/repos/postguard-tb-addon).

End-to-end email encryption extension for Thunderbird. Uses identity-based encryption and [Yivi](https://yivi.app) so users can send and receive encrypted email without managing keys or certificates. This is one of the main end-user products in the PostGuard system.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Thunderbird](https://www.thunderbird.net/) 128+

### Setup

```bash
npm install
cp .env.example .env   # adjust if needed
```

### Build and run

```bash
npm run build          # production build -> dist/
npm run build:dev      # development build (no minification, keeps console.log)
npm run watch          # dev build with file watching
```

To load the extension in Thunderbird: open Add-ons Manager, click the gear icon, select Debug Add-ons, then Load Temporary Add-on and pick any file inside the `dist/` folder.

## Releasing

Update the version in three files:

1. `package.json` (`"version"`)
2. `manifest.json` (`"version"`)
3. `updates.json` (add a new entry with the new version)

Then commit and tag:

```bash
git add package.json manifest.json updates.json
git commit -m "Bump version to X.Y.Z"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

Pushing the `v*` tag triggers CI, which builds the `.xpi` file and creates a GitHub release.

## Build reproducibility

The add-on's WebAssembly module comes from the published `@e4a/pg-wasm`
npm package (transitively, via `@e4a/pg-js`) and is inlined into the
JavaScript bundle by esbuild at build time. See
[`docs/build-reproducibility.md`](./docs/build-reproducibility.md) for
the full supply chain, hash-verification steps, and reviewer notes for
AMO submissions.

## License

MIT
