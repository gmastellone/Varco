import { describe, it, expect } from "vitest";
import { formatBytes, buildShareText } from "../../public/upload.js";

describe("formatBytes", () => {
  it("formats bytes under 1024 as-is", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("buildShareText", () => {
  it("combines the link and password into a pasteable message", () => {
    expect(buildShareText("https://varco.example.com/d/tok", "abc123")).toBe(
      "File: https://varco.example.com/d/tok\nPassword: abc123"
    );
  });
});
