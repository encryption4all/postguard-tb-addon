import { describe, it, expect } from "vitest";
import { toBase64, fromBase64 } from "../src/lib/encoding";

describe("toBase64 / fromBase64", () => {
  it("should round-trip empty data", () => {
    const input = new Uint8Array(0);
    expect(fromBase64(toBase64(input))).toEqual(input);
  });

  it("should round-trip small data", () => {
    const input = new Uint8Array([0, 1, 2, 127, 128, 255]);
    expect(fromBase64(toBase64(input))).toEqual(input);
  });

  it("should round-trip data larger than chunk size (8192)", () => {
    const input = new Uint8Array(10000);
    for (let i = 0; i < input.length; i++) input[i] = i % 256;
    expect(fromBase64(toBase64(input))).toEqual(input);
  });

  it("should round-trip data at exact chunk boundary", () => {
    const input = new Uint8Array(8192);
    for (let i = 0; i < input.length; i++) input[i] = i % 256;
    expect(fromBase64(toBase64(input))).toEqual(input);
  });

  it("should produce valid base64 output", () => {
    const input = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const b64 = toBase64(input);
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(b64).toBe("SGVsbG8=");
  });

  it("should handle all byte values (0-255)", () => {
    const input = new Uint8Array(256);
    for (let i = 0; i < 256; i++) input[i] = i;
    const result = fromBase64(toBase64(input));
    expect(result).toEqual(input);
  });

  it("should handle binary data with null bytes", () => {
    const input = new Uint8Array([0, 0, 0, 1, 0, 0]);
    expect(fromBase64(toBase64(input))).toEqual(input);
  });
});
