import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";

const isDev = process.argv.includes("--dev");
const isWatch = process.argv.includes("--watch");
const outdir = "dist";

// Load .env file if present (KEY=VALUE per line, # comments)
function loadEnv() {
  const envPath = path.resolve(".env");
  if (!existsSync(envPath)) return {};
  const vars = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

const env = loadEnv();

// Build-time environment variables with defaults
const envDefine = {
  "process.env.NODE_ENV": '"production"',
  "process.env.PKG_URL": JSON.stringify(env.PKG_URL || "https://staging.postguard.eu/pkg"),
  "process.env.CRYPTIFY_URL": JSON.stringify(env.CRYPTIFY_URL || "https://fileshare.staging.postguard.eu"),
  "process.env.POSTGUARD_WEBSITE_URL": JSON.stringify(env.POSTGUARD_WEBSITE_URL || "https://staging.postguard.eu"),
};

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

  // Copy pg-wasm WASM binary and JS bindings for manual loading.
  // public/pg-wasm/load.js (our custom loader) is already copied above.
  // pg-wasm >=0.5 puts bundler files under bundler/ subdirectory
  const pgWasmPkg = "node_modules/@e4a/pg-wasm";
  const pgWasmSrc = existsSync(path.join(pgWasmPkg, "bundler"))
    ? path.join(pgWasmPkg, "bundler")
    : pgWasmPkg;
  const pgWasmDest = path.join(outdir, "pg-wasm");
  mkdirSync(pgWasmDest, { recursive: true });
  for (const f of ["index_bg.js", "index_bg.wasm"]) {
    if (existsSync(path.join(pgWasmSrc, f))) {
      cpSync(path.join(pgWasmSrc, f), path.join(pgWasmDest, f));
    }
  }
}

copyStatic();

// Packages that are unused in the extension context.
const pgExternals = [
  "@transcend-io/conflux",
];

// esbuild plugin to remap @e4a/pg-wasm to our custom loader and shim Node-only packages.
// - pg-wasm: The SDK dynamically imports @e4a/pg-wasm, but Thunderbird can't resolve
//   bare specifiers at runtime. We remap it to ./pg-wasm/load.js (our custom WASM loader)
//   and keep it external so import.meta.url resolves correctly inside load.js.
// - eventsource: yivi-client imports this Node SSE polyfill at the top level,
//   but we disable SSE in our config so it's never used at runtime.
const extensionPlugins = {
  name: "extension-plugins",
  setup(build) {
    // Remap @e4a/pg-wasm to custom loader (kept external).
    // Use absolute extension path so it resolves correctly from any script location.
    build.onResolve({ filter: /^@e4a\/pg-wasm$/ }, () => ({
      path: "/pg-wasm/load.js",
      external: true,
    }));
    // Shim eventsource (unused Node polyfill)
    build.onResolve({ filter: /^eventsource$/ }, () => ({
      path: "eventsource",
      namespace: "shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
      contents: "export default class {}; export class EventSource {}",
      loader: "js",
    }));
  },
};

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
  plugins: [extensionPlugins],
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
  plugins: [extensionPlugins],
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
