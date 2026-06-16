import { describe, it, expect } from "vitest";
import {
  MOBILE_NUMBER_ATTR_TYPE,
  validateMobileNumber,
} from "../src/pages/policy-editor/phone";

describe("validateMobileNumber — recipient phone validation", () => {
  it("exposes the Yivi mobile-number attribute type", () => {
    expect(MOBILE_NUMBER_ATTR_TYPE).toBe(
      "pbdf.sidn-pbdf.mobilenumber.mobilenumber"
    );
  });

  it("normalises a Dutch local-format number to E.164", () => {
    expect(validateMobileNumber("0612345678")).toEqual({
      valid: true,
      e164: "+31612345678",
    });
  });

  it("accepts an already-canonical E.164 number unchanged", () => {
    expect(validateMobileNumber("+31612345678")).toEqual({
      valid: true,
      e164: "+31612345678",
    });
  });

  it("tolerates spaces and dashes in a valid number", () => {
    expect(validateMobileNumber("06 12 34 56 78")).toEqual({
      valid: true,
      e164: "+31612345678",
    });
    expect(validateMobileNumber("+31 6 1234 5678")).toEqual({
      valid: true,
      e164: "+31612345678",
    });
  });

  it("treats an empty (or whitespace-only) input as valid with no value", () => {
    // The mobile-number attribute is optional, so a blank field is not an
    // error — it just means "no mobile number".
    expect(validateMobileNumber("")).toEqual({ valid: true, e164: null });
    expect(validateMobileNumber("   ")).toEqual({ valid: true, e164: null });
  });

  it("rejects too-short / nonsense numbers", () => {
    for (const bad of ["12345", "06123", "0", "999"]) {
      expect(validateMobileNumber(bad)).toEqual({ valid: false, e164: null });
    }
  });

  it("rejects non-numeric input", () => {
    for (const bad of ["abc", "not a phone", "06abcdefgh"]) {
      expect(validateMobileNumber(bad)).toEqual({ valid: false, e164: null });
    }
  });

  it("rejects a Dutch landline (not a mobile number)", () => {
    // libphonenumber-js/mobile distinguishes mobile from fixed-line; a
    // landline must not pass mobile-number validation.
    expect(validateMobileNumber("0201234567").valid).toBe(false);
  });

  it("respects the country used to interpret local-format input", () => {
    // A UK mobile in local format only validates under the GB region.
    expect(validateMobileNumber("07400123456", "GB")).toEqual({
      valid: true,
      e164: "+447400123456",
    });
    expect(validateMobileNumber("07400123456", "NL").valid).toBe(false);
  });
});
