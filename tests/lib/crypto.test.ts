import { describe, it, expect } from "vitest";
import {
  generatePassword,
  generateToken,
  generateSalt,
  sha256Hex,
  hashPassword,
  constantTimeEqual,
} from "../../src/lib/crypto";

describe("generatePassword", () => {
  it("returns a 12-character string", () => {
    expect(generatePassword()).toHaveLength(12);
  });

  it("only uses unambiguous alphabet characters", () => {
    const password = generatePassword();
    expect(password).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]+$/);
  });

  it("generates different passwords across calls", () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(passwords.size).toBe(20);
  });
});

describe("generateToken", () => {
  it("returns a 64-character hex string (32 bytes)", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("generates different tokens across calls", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("generateSalt", () => {
  it("returns a 32-character hex string (16 bytes)", () => {
    const salt = generateSalt();
    expect(salt).toHaveLength(32);
    expect(salt).toMatch(/^[0-9a-f]+$/);
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 test vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("hashPassword", () => {
  it("hashes salt concatenated with password", async () => {
    const direct = await sha256Hex("saltvaluepassword123");
    const viaHelper = await hashPassword("password123", "saltvalue");
    expect(viaHelper).toBe(direct);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constantTimeEqual("abcdef", "abcxef")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
