import { describe, it, expect } from "vitest";
import { extractFilename } from "../../public/download.js";

describe("extractFilename", () => {
  it("extracts the filename from a Content-Disposition header", () => {
    expect(extractFilename('attachment; filename="report.pdf"')).toBe("report.pdf");
  });

  it("falls back to a default name when the header is missing", () => {
    expect(extractFilename(null)).toBe("download");
  });

  it("falls back to a default name when no filename is present", () => {
    expect(extractFilename("attachment")).toBe("download");
  });
});
