import "dotenv/config";
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import path from "path";

const isDev = process.argv.includes("--dev");
const isWatch = process.argv.includes("--watch");
const outdir = "dist";

// Build-time environment variables (set via .env file, see .env.example)
const envDefine = {
  "process.env.NODE_ENV": '"production"',
};
for (const key of ["PKG_URL", "CRYPTIFY_URL", "POSTGUARD_WEBSITE_URL"]) {
  if (process.env[key]) {
    envDefine[`process.env.${key}`] = JSON.stringify(process.env[key]);
  }
}

// In release builds, strip console.log calls (marked pure so minification
// removes them since the return value is never used) and minify output.
const releaseOptions = isDev
  ? {}
  : { pure: ["console.log"], minify: true };

// Ensure dist exists
mkdirSync(outdir, { recursive: true });

// Copy static assets
function copyStatic() {
  cpSync("manifest.json", path.join(outdir, "manifest.json"));
  cpSync("public", outdir, { recursive: true });

  // Copy pg-wasm binary next to each script that uses PostGuard.
  // The pg-wasm web target's init() loads it via new URL('index_bg.wasm', import.meta.url).
  const wasmCandidates = [
    "node_modules/@e4a/pg-wasm/web/index_bg.wasm",
    "node_modules/@e4a/pg-js/node_modules/@e4a/pg-wasm/web/index_bg.wasm",
  ];
  const wasmSrc = wasmCandidates.find((p) => existsSync(p));
  if (wasmSrc) {
    cpSync(wasmSrc, path.join(outdir, "index_bg.wasm"));
    cpSync(wasmSrc, path.join(outdir, "pages/yivi-popup/index_bg.wasm"));
  }
}

copyStatic();

// Packages that are unused in the extension context.
const pgExternals = [
  "@transcend-io/conflux",
];

// Background script
const backgroundBuild = {
  entryPoints: ["src/background/background.ts"],
  bundle: true,
  outfile: path.join(outdir, "background.js"),
  format: "esm",
  target: "firefox128",
  platform: "browser",
  define: envDefine,
  external: pgExternals,

  ...releaseOptions,
};

// Message display content script
const messageDisplayBuild = {
  entryPoints: ["src/content/message-display.ts"],
  bundle: true,
  outfile: path.join(outdir, "content/message-display.js"),
  format: "iife",
  target: "firefox128",
  platform: "browser",
  ...releaseOptions,
};

// Message display CSS
const messageDisplayCssBuild = {
  entryPoints: ["src/content/message-display.css"],
  bundle: true,
  outfile: path.join(outdir, "content/message-display.css"),
};

// Compose action popup
const composePopupBuild = {
  entryPoints: ["src/pages/compose-action/compose-action.ts"],
  bundle: true,
  outfile: path.join(outdir, "pages/compose-action/compose-action.js"),
  format: "iife",
  target: "firefox128",
  platform: "browser",
  ...releaseOptions,
};

// Policy editor popup
const policyEditorBuild = {
  entryPoints: ["src/pages/policy-editor/policy-editor.ts"],
  bundle: true,
  outfile: path.join(outdir, "pages/policy-editor/policy-editor.js"),
  format: "iife",
  target: "firefox128",
  platform: "browser",
  ...releaseOptions,
};

// Yivi popup (ESM format for dynamic WASM import via PostGuard SDK)
const yiviPopupBuild = {
  entryPoints: ["src/pages/yivi-popup/yivi-popup.ts"],
  bundle: true,
  outfile: path.join(outdir, "pages/yivi-popup/yivi-popup.js"),
  format: "esm",
  target: "firefox128",
  platform: "browser",
  define: envDefine,
  external: pgExternals,

  ...releaseOptions,
};

const builds = [
  backgroundBuild,
  messageDisplayBuild,
  messageDisplayCssBuild,
  composePopupBuild,
  policyEditorBuild,
  yiviPopupBuild,
];

// Filter out builds whose entry points don't exist yet
const activeBuildConfigs = builds.filter((config) =>
  config.entryPoints.every((ep) => existsSync(ep))
);

if (isWatch) {
  for (const config of activeBuildConfigs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log("Watching for changes...");
} else {
  for (const config of activeBuildConfigs) {
    await esbuild.build(config);
  }
  console.log("Build complete.");
}
