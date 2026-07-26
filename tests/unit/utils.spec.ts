/// <reference types="vitest/globals" />
import {
  generateRandomHexString,
  getUseableDatesFromMs,
} from "../../src/core/utils";

describe("Utils", () => {
  it("generates a hex string of the requested length", () => {
    const value = generateRandomHexString(16);
    expect(value).toHaveLength(16);
    expect(value).toMatch(/^[0-9a-f]+$/);
  });

  it("throws when requested length is odd", () => {
    expect(() => generateRandomHexString(3)).toThrow(
      "Length must be an even number",
    );
  });

  it("converts milliseconds to day/hour/minute/second parts", () => {
    const ms =
      2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000 + 4 * 60 * 1000 + 5 * 1000;
    expect(getUseableDatesFromMs(ms)).toEqual({
      days: 2,
      hours: 3,
      minutes: 4,
      seconds: 5,
    });
  });
});
