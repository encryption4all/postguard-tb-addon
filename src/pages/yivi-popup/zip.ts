/** Extract a single file from a ZIP blob and return its uncompressed
 *  bytes. Reads via the central directory because conflux (pg-js's zip
 *  writer) emits streaming-mode local file headers with `compressedSize:
 *  0`. Supports stored (method 0) and deflate (method 8); the latter via
 *  DecompressionStream('deflate-raw'), the right decoder for ZIP-embedded
 *  deflate. */
export async function extractFromZip(blob: Blob, filename: string): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder("utf-8");

  let eocdOffset = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 65557);
    i--
  ) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("ZIP EOCD record not found");

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const numEntries = view.getUint16(eocdOffset + 10, true);

  let pos = cdOffset;
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;

    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const lfhOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(
      bytes.slice(pos + 46, pos + 46 + nameLen)
    );

    if (name === filename) {
      const lfhNameLen = view.getUint16(lfhOffset + 26, true);
      const lfhExtraLen = view.getUint16(lfhOffset + 28, true);
      const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);

      if (method === 0) return compressed;
      if (method === 8) {
        const stream = new Blob([compressed as BlobPart])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error(`Unsupported zip compression method ${method} for ${filename}`);
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(`File "${filename}" not found in zip`);
}
