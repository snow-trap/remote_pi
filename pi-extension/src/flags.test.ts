import { describe, expect, test } from "vitest";
import { flagFromArgv, isPrintMode, resolveFeatureFlags } from "./flags.js";

describe("flags — --relay / --mesh resolution", () => {
  test("no flags → both off", () => {
    expect(resolveFeatureFlags(() => undefined, ["pi"])).toEqual({ relay: false, mesh: false });
  });

  test("getFlag boolean true enables each feature", () => {
    const get = (name: string) => name === "relay" ? true : undefined;
    expect(resolveFeatureFlags(get, [])).toEqual({ relay: true, mesh: false });
  });

  test("argv presence enables each feature", () => {
    expect(resolveFeatureFlags(undefined, ["pi", "--mesh"])).toEqual({ relay: false, mesh: true });
    expect(resolveFeatureFlags(undefined, ["pi", "--relay", "--mesh"])).toEqual({ relay: true, mesh: true });
  });

  test("getFlag wins but argv backstops (rebound-runtime hosts)", () => {
    expect(resolveFeatureFlags(() => undefined, ["pi", "--relay"])).toEqual({ relay: true, mesh: false });
    expect(resolveFeatureFlags(() => false, ["pi", "--mesh"])).toEqual({ relay: false, mesh: true });
  });

  test("flagFromArgv matches exact tokens only", () => {
    expect(flagFromArgv("relay", ["--relay"])).toBe(true);
    expect(flagFromArgv("relay", ["--relay=1"])).toBe(false);
    expect(flagFromArgv("relay", ["--relays"])).toBe(false);
  });

  test("isPrintMode detects -p / --print", () => {
    expect(isPrintMode(["pi", "-p", "hi"])).toBe(true);
    expect(isPrintMode(["pi", "--print", "hi"])).toBe(true);
    expect(isPrintMode(["pi", "--relay"])).toBe(false);
  });
});
