// Encryption wrapper around @e4a/pg-wasm

export interface SealOptions {
  skipEncryption?: boolean;
  policy: Record<string, { ts: number; con: Array<{ t: string; v: string }> }>;
  pubSignKey: unknown;
  privSignKey?: unknown;
}

// Module-level reference to pg-wasm, set at startup
let sealStreamFn: ((
  pk: string,
  opts: SealOptions,
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>
) => Promise<void>) | null = null;

export function setSealStream(fn: typeof sealStreamFn) {
  sealStreamFn = fn;
}

export async function sealData(
  publicKey: string,
  options: SealOptions,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  if (!sealStreamFn) throw new Error("pg-wasm sealStream not initialized");

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(plaintext);
      controller.close();
    },
  });

  let encrypted = new Uint8Array(0);
  const writable = new WritableStream<Uint8Array>({
    write(chunk: Uint8Array) {
      const combined = new Uint8Array(encrypted.length + chunk.length);
      combined.set(encrypted);
      combined.set(chunk, encrypted.length);
      encrypted = combined;
    },
  });

  const fullOptions = { skipEncryption: false, ...options };
  const tStart = performance.now();
  await sealStreamFn(publicKey, fullOptions, readable, writable);
  console.log(
    `[PostGuard] Encryption took ${(performance.now() - tStart).toFixed(0)}ms`
  );

  return encrypted;
}
