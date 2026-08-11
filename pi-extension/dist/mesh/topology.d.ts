/**
 * Shared mesh-topology validation/normalization.
 *
 * Single home for the helpers that used to be duplicated between
 * `bridge.ts` and `node.ts` (~90 lines each). Both producers normalize a
 * `MeshTopologySnapshot` into a canonical frozen shape: canonical Ed25519
 * pubkeys, validated routing aliases, deduped siblings sorted by pubkey.
 */
import type { MeshTopologySnapshot } from "./siblings.js";
export declare function compareAscii(left: string, right: string): number;
export declare function validateAlias(alias: unknown, field: string): string;
export declare function validateLegacyPcLabel(label: unknown, field: string): string;
/**
 * Normalize + validate a topology snapshot. When `expectedSelfPubkey` is
 * given, the snapshot's self key must match it (bridge.ts's stricter
 * attach-time check; node.ts's runtime path passes none).
 */
export declare function ownTopology(snapshot: MeshTopologySnapshot, expectedSelfPubkey?: string): MeshTopologySnapshot;
