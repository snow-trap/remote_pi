/**
 * RelayService tests — pairing, ping/pong routing, and prompt-injection
 * hygiene (the pair QR must go to appendEntry, NEVER to a custom message
 * that would land in the LLM context).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";

// ── Mock RelayClient ──────────────────────────────────────────────────────────

const relayRef: { current: MockRelay | null } = { current: null };

class MockRelay extends EventEmitter {
  static OPEN = 1;
  readyState = MockRelay.OPEN;
  connect     = vi.fn(async () => undefined);
  send        = vi.fn();
  sendControl = vi.fn();
  close       = vi.fn(() => { this.readyState = 3; });
  isOpen() { return this.readyState === MockRelay.OPEN; }
  constructor() { super(); relayRef.current = this; }
}

vi.mock("./client.js", () => ({
  RelayClient: MockRelay,
  RoomAlreadyOpenError: class RoomAlreadyOpenError extends Error {},
}));

// ── Mock storage (no real keyring / peers.json) ───────────────────────────────

const storageHarness = vi.hoisted(() => ({
  keypair: {
    publicKey: new Uint8Array(32).fill(1),
    secretKey: new Uint8Array(32).fill(2),
  },
  peers: [] as Array<{ name: string; remote_epk: string; paired_at: string }>,
}));

vi.mock("./storage.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./storage.js")>();
  return {
    ...orig,
    getOrCreateEd25519Keypair: vi.fn().mockResolvedValue(storageHarness.keypair),
    listPeers: vi.fn(async () => storageHarness.peers),
    snapshotOwnerPubkeys: vi.fn().mockRejectedValue(new Error("no snapshot in tests")),
    conditionalRemovePeer: vi.fn(async () => false),
    addPeer: vi.fn(async (p: { name: string; remote_epk: string; paired_at: string }) => {
      storageHarness.peers.push(p);
    }),
    removePeer: vi.fn(async (epk: string) => {
      storageHarness.peers = storageHarness.peers.filter((p) => p.remote_epk !== epk);
    }),
  };
});

// ── Mock qr token session ─────────────────────────────────────────────────────

vi.mock("./qr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./qr.js")>();
  return {
    ...orig,
    renderQRAscii: vi.fn().mockReturnValue("<<QR-ASCII>>"),
    qrSession: {
      issueToken: vi.fn().mockReturnValue({ token: "test-token", expiresAt: Date.now() + 60_000 }),
      consumeToken: vi.fn().mockReturnValue("ok"),
      clear: vi.fn(),
    },
  };
});

// ── Mock SelfRevoke + MeshClient (no network in unit tests) ───────────────────

vi.mock("../mesh/self_revoke.js", () => ({
  SelfRevoke: class MockSelfRevoke {
    static instances: MockSelfRevoke[] = [];
    constructor(readonly options: unknown) { MockSelfRevoke.instances.push(this); }
    start() {}
    stop() {}
    invalidateStorageAuthority() {}
    async checkOnce() {}
    async requestFreshCheck() {}
  },
}));

vi.mock("../mesh/client.js", () => ({
  MeshClient: class MockMeshClient {},
}));

const { RelayService } = await import("./relay_service.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const OWNER_EPK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function makeCtx() {
  return { ui: { notify: vi.fn() }, cwd: "/tmp/test", abort: vi.fn() };
}

function makeDeps() {
  const pi = {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium"),
  };
  return {
    pi,
    deps: {
      getPi: () => pi as never,
      getMeshNode: () => null,
      getDisplayName: () => "test-agent",
      getCommandCtx: () => null,
      getEventCtx: () => null,
      setCommandCtx: () => undefined,
      getCwd: () => "/tmp/test",
      notify: vi.fn(),
      refreshFooter: vi.fn(),
      isDisposed: () => false,
    },
  };
}

function makeInnerLine(peer: string, inner: object): string {
  const ct = Buffer.from(JSON.stringify(inner)).toString("base64");
  return JSON.stringify({ peer, ct });
}

function decodeSentCt(raw: string): { peer: string; inner: Record<string, unknown> } {
  const outer = JSON.parse(raw) as { peer: string; ct: string };
  const inner = JSON.parse(Buffer.from(outer.ct, "base64").toString("utf8"));
  return { peer: outer.peer, inner };
}

async function startedService() {
  const { pi, deps } = makeDeps();
  const service = new RelayService(deps);
  await service.start(makeCtx() as never);
  return { service, pi, relay: relayRef.current! };
}

async function pairedService() {
  const ctx = await startedService();
  const { relay } = ctx;
  relay.emit("message", makeInnerLine(OWNER_EPK, {
    type: "pair_request",
    id: "pair-1",
    token: "test-token",
    device_name: "Test Phone",
  }));
  await vi.waitFor(() => {
    if (!ctx.service.hasAnyPeer) throw new Error("not paired yet");
  });
  return ctx;
}

beforeEach(() => {
  relayRef.current = null;
  storageHarness.peers = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RelayService lifecycle", () => {
  test("start connects the relay with a derived room; no mesh required", async () => {
    const { service, relay } = await startedService();
    expect(service.isStarted).toBe(true);
    expect(relay.connect).toHaveBeenCalledTimes(1);
    const hello = relay.connect.mock.calls[0]![0] as { roomId: string; roomMeta: { name: string } };
    expect(hello.roomId).toBeTruthy();
    expect(hello.roomMeta.name).toBe("test-agent");
  });

  test("stop goes idle and closes the WS", async () => {
    const { service, relay } = await startedService();
    service.stop("peer_stop");
    expect(service.isStarted).toBe(false);
    expect(relay.close).toHaveBeenCalled();
  });

  test("double start is a no-op with a warning", async () => {
    const { service, relay } = await startedService();
    const ctx = makeCtx();
    await service.start(ctx as never);
    expect(relay.connect).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already started"), "warning");
  });});

describe("pairing + routing", () => {
  test("pair_request with a valid token attaches the owner and replies pair_ok", async () => {
    const { service, relay } = await pairedService();
    expect(service.hasAnyPeer).toBe(true);
    const pairOk = relay.send.mock.calls
      .map((c) => decodeSentCt(c[0] as string))
      .find((m) => m.inner["type"] === "pair_ok");
    expect(pairOk).toBeDefined();
    expect(pairOk!.peer).toBe(OWNER_EPK);
    expect(pairOk!.inner["session_name"]).toBe("test-agent");
  });

  test("ping from a paired peer → pong with matching in_reply_to", async () => {
    const { relay } = await pairedService();
    relay.emit("message", makeInnerLine(OWNER_EPK, { type: "ping", id: "p1" }));
    await vi.waitFor(() => {
      const pong = relay.send.mock.calls
        .map((c) => decodeSentCt(c[0] as string))
        .find((m) => m.inner["type"] === "pong");
      expect(pong).toBeDefined();
      expect(pong!.inner["in_reply_to"]).toBe("p1");
    });
  });

  test("non-pair message from an UNKNOWN peer → error: unknown_peer", async () => {
    const { relay } = await startedService();
    relay.emit("message", makeInnerLine(OWNER_EPK, { type: "ping", id: "p1" }));
    await vi.waitFor(() => {
      const err = relay.send.mock.calls
        .map((c) => decodeSentCt(c[0] as string))
        .find((m) => m.inner["type"] === "error");
      expect(err).toBeDefined();
      expect(err!.inner["code"]).toBe("unknown_peer");
    });
  });

  test("revoke tears down the live channel and removes the peer", async () => {
    const { service, relay } = await pairedService();
    const ctx = makeCtx();
    await service.revoke(OWNER_EPK.slice(0, 8), ctx as never);
    expect(service.hasAnyPeer).toBe(false);
    expect(storageHarness.peers).toHaveLength(0);
    void relay;
  });
});

describe("prompt-injection hygiene", () => {
  test("pair QR goes to appendEntry (TUI-only) — never to a custom message", async () => {
    const { service, pi } = await startedService();
    await service.pair(makeCtx() as never);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "remote-pi:pair-code",
      expect.objectContaining({ ascii: "<<QR-ASCII>>", uri: expect.stringContaining("remotepi://") }),
    );
    // No sendMessage call at all on the pair path (the only custom message
    // this extension sends is remote-pi:mesh-message from MeshService).
    const pairCodeMsg = pi.sendMessage.mock.calls.find(
      (c) => (c[0] as { customType?: string }).customType === "remote-pi:pair-code",
    );
    expect(pairCodeMsg).toBeUndefined();
  });
});
