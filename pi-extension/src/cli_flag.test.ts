import { describe, expect, test } from "vitest";
import { cliRemotePiValue, resolveCliRemotePiMode } from "./index.js";

// Plan/58 — `--remote-pi <mesh|relay|both|off>` parser. Pure functions over
// argv so the auto-start gating in index.ts is unit-testable without a host.
describe("cliRemotePiValue", () => {
  test("absent flag → undefined", () => {
    expect(cliRemotePiValue(["pi", "--print", "prompt"])).toBeUndefined();
  });

  test("space form `--remote-pi mesh`", () => {
    expect(cliRemotePiValue(["pi", "--remote-pi", "mesh"])).toBe("mesh");
  });

  test("equals form `--remote-pi=relay`", () => {
    expect(cliRemotePiValue(["pi", "--remote-pi=relay"])).toBe("relay");
  });

  test("equals form with empty value", () => {
    expect(cliRemotePiValue(["pi", "--remote-pi="])).toBe("");
  });

  test("flag with missing value → undefined (next arg treated as positional)", () => {
    expect(cliRemotePiValue(["pi", "--remote-pi"])).toBeUndefined();
  });

  test("last occurrence wins", () => {
    expect(cliRemotePiValue(["pi", "--remote-pi", "off", "--remote-pi", "both"])).toBe("both");
  });

  test("unrelated --remote-pi-xyz flag is not matched", () => {
    expect(cliRemotePiValue(["pi", "--remote-pi-xyz=1"])).toBeUndefined();
  });
});

describe("resolveCliRemotePiMode", () => {
  test("valid values pass through", () => {
    for (const mode of ["mesh", "relay", "both", "off"] as const) {
      expect(resolveCliRemotePiMode(["pi", "--remote-pi", mode])).toBe(mode);
    }
  });

  test("invalid value → undefined (caller warns + falls back)", () => {
    expect(resolveCliRemotePiMode(["pi", "--remote-pi", "bogus"])).toBeUndefined();
    expect(resolveCliRemotePiMode(["pi", "--remote-pi=ALL"])).toBeUndefined();
  });

  test("absent flag → undefined (legacy config-driven behavior preserved)", () => {
    expect(resolveCliRemotePiMode(["pi"])).toBeUndefined();
  });
});
