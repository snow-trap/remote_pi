import type { Broker } from "./broker.js";
import { BrokerRemote } from "./broker_remote.js";
import { PiForwardClient } from "./forward.js";
import type { RelayClient } from "../relay/client.js";
import { MeshClient } from "./client.js";
import {
  buildTopologySnapshot,
  discoverTopology,
  type MeshTopologySnapshot,
} from "./siblings.js";
import { encodeEd25519PublicKey } from "./encoding.js";
import { listOwnerPubkeys } from "../relay/storage.js";
import { ownTopology } from "./topology.js";
import type { Ed25519Keypair } from "../relay/crypto.js";

/**
 * Cross-PC mesh bridge composition. Discovery finishes before either transport
 * half is constructed, and the returned bridge stays dormant until its caller
 * has re-checked lifecycle ownership and calls `activate()`.
 */

export interface AttachBridgeOptions {
  /** The leader's local Broker (from SessionPeer.localBroker()). */
  broker: Broker;
  /** Live relay connection. Caller owns its lifecycle. */
  relay: RelayClient;
  /** Relay URL in http(s):// form — for standalone topology discovery. */
  relayUrl: string;
  /** This host's Ed25519 identity (machine Pi-key). */
  keypair: Ed25519Keypair;
  /** Retained Pi-produced topology. Supplying it bypasses discovery. */
  topology?: MeshTopologySnapshot;
  /** Standalone discovery deadline per mesh request. Defaults to 5 seconds. */
  meshRequestTimeoutMs?: number;
  /** Diagnostic logger. Defaults to a no-op (avoids TUI leaks). */
  log?: (msg: string) => void;
}

export interface CrossPcBridge {
  brokerRemote: BrokerRemote;
  piForward: PiForwardClient;
  topology: MeshTopologySnapshot;
  /** Publish the already-built router exactly once. */
  activate(): void;
  /** Safe before or after activation; tears down both halves exactly once. */
  detach(): void;
}

async function discoverStandaloneTopology(
  opts: AttachBridgeOptions,
): Promise<MeshTopologySnapshot> {
  const silent = { warn: (_message: string): void => { /* metadata stays silent in TUI */ } };
  try {
    const owners = await listOwnerPubkeys();
    return await discoverTopology({
      client: new MeshClient(opts.relayUrl, {
        ...(opts.meshRequestTimeoutMs !== undefined
          ? { requestTimeoutMs: opts.meshRequestTimeoutMs }
          : {}),
      }),
      ownerEpks: owners,
      myPubkey: opts.keypair.publicKey,
      log: silent,
    });
  } catch {
    return buildTopologySnapshot(opts.keypair.publicKey, []);
  }
}

export async function attachCrossPcBridge(
  opts: AttachBridgeOptions,
): Promise<CrossPcBridge> {
  const expectedSelfPubkey = encodeEd25519PublicKey(
    opts.keypair.publicKey,
    "relay public key",
  );
  const topology = ownTopology(
    opts.topology ?? await discoverStandaloneTopology(opts),
    expectedSelfPubkey,
  );

  // No Relay listeners exist until all standalone discovery has completed.
  const piForward = new PiForwardClient(opts.relay);
  let brokerRemote: BrokerRemote;
  try {
    brokerRemote = new BrokerRemote({
      broker: opts.broker,
      pi: piForward,
      topology,
      activateOnConstruct: false,
      log: opts.log ?? ((): void => {}),
    });
  } catch (error) {
    piForward.detach();
    throw error;
  }

  let state: "dormant" | "active" | "detached" = "dormant";
  return {
    brokerRemote,
    piForward,
    topology,
    activate(): void {
      if (state !== "dormant") return;
      try {
        brokerRemote.activate();
        state = "active";
      } catch (error) {
        state = "detached";
        try {
          brokerRemote.detach();
        } finally {
          piForward.detach();
        }
        throw error;
      }
    },
    detach(): void {
      if (state === "detached") return;
      state = "detached";
      try {
        brokerRemote.detach();
      } finally {
        piForward.detach();
      }
    },
  };
}
