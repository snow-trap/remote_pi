/**
 * Shared mesh-topology validation/normalization.
 *
 * Single home for the helpers that used to be duplicated between
 * `bridge.ts` and `node.ts` (~90 lines each). Both producers normalize a
 * `MeshTopologySnapshot` into a canonical frozen shape: canonical Ed25519
 * pubkeys, validated routing aliases, deduped siblings sorted by pubkey.
 */

import { canonicalizeEd25519PublicKey } from "./encoding.js";
import type { MeshTopologySnapshot } from "./siblings.js";

export function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateAlias(alias: unknown, field: string): string {
  if (typeof alias !== "string" || alias.length === 0 || alias.includes(":")) {
    throw new Error(`mesh: ${field} is not a valid routing alias`);
  }
  return alias;
}

export function validateLegacyPcLabel(label: unknown, field: string): string {
  if (typeof label !== "string" || label.length === 0) {
    throw new Error(`mesh: ${field} is not a valid legacy PC label`);
  }
  return label;
}

/**
 * Normalize + validate a topology snapshot. When `expectedSelfPubkey` is
 * given, the snapshot's self key must match it (bridge.ts's stricter
 * attach-time check; node.ts's runtime path passes none).
 */
export function ownTopology(
  snapshot: MeshTopologySnapshot,
  expectedSelfPubkey?: string,
): MeshTopologySnapshot {
  const selfPubkey = canonicalizeEd25519PublicKey(
    snapshot.self?.pcPubkey,
    "self public key",
  );
  if (expectedSelfPubkey !== undefined && selfPubkey !== expectedSelfPubkey) {
    throw new Error("mesh: topology self public key does not match relay identity");
  }
  const selfLabel = validateAlias(snapshot.self?.pcLabel, "self.pcLabel");
  const selfLegacyPcLabel = validateLegacyPcLabel(
    snapshot.self?.legacyPcLabel,
    "self.legacyPcLabel",
  );
  const self = Object.freeze({
    pcLabel: selfLabel,
    pcPubkey: selfPubkey,
    legacyPcLabel: selfLegacyPcLabel,
  });
  const siblingKeys = new Set<string>();
  const siblingAliases = new Set<string>();
  const siblings: Array<Readonly<{
    pcLabel: string;
    pcPubkey: string;
    legacyPcLabel: string;
  }>> = [];
  for (const [index, sibling] of snapshot.siblings.entries()) {
    const pcPubkey = canonicalizeEd25519PublicKey(
      sibling?.pcPubkey,
      `siblings[${index}].pcPubkey`,
    );
    if (pcPubkey === selfPubkey) continue;
    const pcLabel = validateAlias(sibling?.pcLabel, `siblings[${index}].pcLabel`);
    const legacyPcLabel = validateLegacyPcLabel(
      sibling?.legacyPcLabel,
      `siblings[${index}].legacyPcLabel`,
    );
    if (pcLabel === selfLabel || siblingAliases.has(pcLabel)) {
      throw new Error("mesh: duplicate sibling routing alias");
    }
    if (siblingKeys.has(pcPubkey)) {
      throw new Error("mesh: duplicate sibling public key");
    }
    siblingAliases.add(pcLabel);
    siblingKeys.add(pcPubkey);
    siblings.push(Object.freeze({ pcLabel, pcPubkey, legacyPcLabel }));
  }
  siblings.sort((left, right) => compareAscii(left.pcPubkey, right.pcPubkey));
  return Object.freeze({ self, siblings: Object.freeze(siblings) });
}
