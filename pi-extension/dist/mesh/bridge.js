import { BrokerRemote } from "./broker_remote.js";
import { PiForwardClient } from "./forward.js";
import { MeshClient } from "./client.js";
import { buildTopologySnapshot, discoverTopology, } from "./siblings.js";
import { encodeEd25519PublicKey } from "./encoding.js";
import { listOwnerPubkeys } from "../relay/storage.js";
import { ownTopology } from "./topology.js";
async function discoverStandaloneTopology(opts) {
    const silent = { warn: (_message) => { } };
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
    }
    catch {
        return buildTopologySnapshot(opts.keypair.publicKey, []);
    }
}
export async function attachCrossPcBridge(opts) {
    const expectedSelfPubkey = encodeEd25519PublicKey(opts.keypair.publicKey, "relay public key");
    const topology = ownTopology(opts.topology ?? await discoverStandaloneTopology(opts), expectedSelfPubkey);
    // No Relay listeners exist until all standalone discovery has completed.
    const piForward = new PiForwardClient(opts.relay);
    let brokerRemote;
    try {
        brokerRemote = new BrokerRemote({
            broker: opts.broker,
            pi: piForward,
            topology,
            activateOnConstruct: false,
            log: opts.log ?? (() => { }),
        });
    }
    catch (error) {
        piForward.detach();
        throw error;
    }
    let state = "dormant";
    return {
        brokerRemote,
        piForward,
        topology,
        activate() {
            if (state !== "dormant")
                return;
            try {
                brokerRemote.activate();
                state = "active";
            }
            catch (error) {
                state = "detached";
                try {
                    brokerRemote.detach();
                }
                finally {
                    piForward.detach();
                }
                throw error;
            }
        },
        detach() {
            if (state === "detached")
                return;
            state = "detached";
            try {
                brokerRemote.detach();
            }
            finally {
                piForward.detach();
            }
        },
    };
}
//# sourceMappingURL=bridge.js.map