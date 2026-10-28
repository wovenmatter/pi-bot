import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.ts";

describe("package", () => {
  it("exports a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
