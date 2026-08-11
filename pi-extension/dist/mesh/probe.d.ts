/**
 * Read-only probe of the local UDS broker for the mesh roster.
 *
 * Opens a raw connection, sends a single unregistered `list_peers` request,
 * and resolves with the peer addresses from the broker's reply (local UDS
 * peers + cross-PC `<pc>:<peer>` entries).
 *
 * The probe deliberately does NOT register as a peer: the broker answers
 * observer probes without assigning a name or broadcasting peer_joined/left
 * (see Broker._tryObserverProbe), so a query never perturbs the mesh — no
 * phantom peer flashes in anyone's roster, local or cross-PC.
 *
 * Resolves null when no broker is reachable (connection refused / no socket
 * file), or on timeout.
 */
export declare function probeListPeers(sockPath: string, timeoutMs?: number): Promise<string[] | null>;
