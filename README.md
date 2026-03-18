# PostGuard Thunderbird Add-on

End-to-end email encryption extension for Thunderbird using identity-based encryption and [Yivi](https://yivi.app).

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Thunderbird](https://www.thunderbird.net/) 128+

### Setup

```bash
npm install
cp .env.example .env   # adjust if needed
```

### Build & Run

```bash
npm run build          # production build → dist/
npm run build:dev      # development build (no minification, keeps console.log)
npm run watch          # dev build with file watching
```

To load the extension in Thunderbird: open **Add-ons Manager → gear icon → Debug Add-ons → Load Temporary Add-on**, then select any file inside the `dist/` folder.

## Updating the Version

The version must be updated in three files:

1. `package.json` — `"version"`
2. `manifest.json` — `"version"`
3. `updates.json` — add a new entry with the new version

Then commit, push, and tag:

```bash
git add package.json manifest.json updates.json
git commit -m "Bump version to X.Y.Z"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

Pushing the `v*` tag triggers the CI pipeline which builds the `.xpi` and creates a GitHub release.
