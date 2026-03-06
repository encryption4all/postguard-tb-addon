// Custom WASM loader for Thunderbird extension context.
// Thunderbird blocks direct .wasm ESM imports, so we load it manually
// via fetch() + WebAssembly.instantiate().

import * as bg from "./index_bg.js";

const wasmUrl = new URL("./index_bg.wasm", import.meta.url);
const wasmResponse = await fetch(wasmUrl);
const wasmBytes = await wasmResponse.arrayBuffer();

// Build the import object that the WASM module expects.
// wasm-bindgen generated code exports __wbg_* functions that the WASM
// module imports. We collect them all from index_bg.js.
const imports = { "./index_bg.js": bg };

const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
bg.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();

// Re-export everything from index_bg.js (sealStream, StreamUnsealer, etc.)
export * from "./index_bg.js";
