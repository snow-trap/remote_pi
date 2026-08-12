/**
 * Extension shell tests — the lean rewrite's defining behaviors:
 *
 *   1. OFF by default: a bare `pi` boot never auto-starts anything, deploys
 *      no skill, registers no agent tools (full invisibility).
 *   2. `--relay` / `--mesh` gate the session_start auto-start.
 *   3. Commands route to the services; `start relay|mesh|all` overrides.
 *   4. The mesh name follows the pi session name (session_info_changed →
 *      MeshService.rename).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Mock the two services (shell orchestration is what we test) ──────────────

const relayHarness = vi.hoisted(() => ({ instances: [] as any[] }));
const meshHarness = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock("./relay/relay_service.js", () => ({
  RelayService: class MockRelayService {
    isStarted = false;
    hasAnyPeer = false;
    pairedBefore = false;
    connectedPeerShort = "";
    currentPeerCount = 0;
    start = vi.fn(async () => { this.isStarted = true; });
    stop = vi.fn(() => { this.isStarted = false; });
    dispose = vi.fn(() => { this.isStarted = false; });
    pair = vi.fn(async () => undefined);
    listDevices = vi.fn(async () => undefined);
    revoke = vi.fn(async () => undefined);
    shortidCompletions = vi.fn(async () => []);
    broadcastToActive = vi.fn();
    attachBridgeIfReady = vi.fn();
    refreshPairingsCache = vi.fn();
    onUserInput = vi.fn();
    onModelSelect = vi.fn();
    onThinkingSelect = vi.fn();
    onTurnStart = vi.fn();
    onTurnEnd = vi.fn();
    onMessageStart = vi.fn();
    onMessageUpdate = vi.fn();
    onToolExecutionStart = vi.fn();
    onToolExecutionEnd = vi.fn();
    onMessageEnd = vi.fn();
    onAgentEnd = vi.fn();
    onBeforeCompact = vi.fn();
    onCompact = vi.fn();
    statusLine = vi.fn(() => "⚪ Relay: off");
    constructor(readonly deps: unknown) { relayHarness.instances.push(this); }
  },
}));

vi.mock("./mesh/mesh_service.js", () => ({
  MeshService: class MockMeshService {
    isJoined = false;
    currentNode = null;
    currentPeerCount = 0;
    join = vi.fn(async () => { this.isJoined = true; });
    leave = vi.fn(async () => { this.isJoined = false; });
    dispose = vi.fn(async () => { this.isJoined = false; });
    rename = vi.fn(async (name: string) => name);
    onAgentStart = vi.fn();
    onAgentEnd = vi.fn();
    statusLine = vi.fn(() => "⚪ Local mesh: not connected");
    constructor(readonly deps: unknown) { meshHarness.instances.push(this); }
  },
}));

const skillHarness = vi.hoisted(() => ({
  deploy: vi.fn(),
  undeploy: vi.fn(),
}));

vi.mock("./mesh/skill.js", () => ({
  deployAgentNetworkSkill: skillHarness.deploy,
  undeployAgentNetworkSkill: skillHarness.undeploy,
}));

const toolsHarness = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("./mesh/tools.js", () => ({ registerAgentTools: toolsHarness.register }));

vi.mock("./mesh/paths.js", () => ({
  ensureGlobalDirs: vi.fn(),
  skillsDir: vi.fn(() => "/tmp/skills"),
  LOCAL_SESSION_NAME: "local",
}));

vi.mock("./relay/images.js", () => ({
  registerReceivedImageRenderer: vi.fn(),
  filterReceivedImageMessagesFromContext: vi.fn((msgs: unknown[]) => msgs),
}));

const { default: extension } = await import("./index.js");

// ── Mock pi ───────────────────────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => unknown;

function makePi(flagValues: Record<string, boolean | string | undefined>) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const pi = {
    registerFlag: vi.fn(),
    getFlag: (name: string) => flagValues[name],
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, opts: { handler: (args: string, ctx: any) => unknown }) => {
      commands.set(name, opts);
    },
    registerTool: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    getSessionName: vi.fn(() => "my-session"),
    getThinkingLevel: vi.fn(() => "medium"),
  };
  const emit = async (event: string, evt: any = {}, ctx: any = makeCtx()) => {
    for (const h of handlers.get(event) ?? []) await h(evt, ctx);
  };
  const run = (cmd: string, args: string, ctx: any = makeCtx()) =>
    commands.get(cmd)!.handler(args, ctx);
  return { pi, handlers, commands, emit, run };
}

function makeCtx() {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
    cwd: "/tmp/test",
    abort: vi.fn(),
    compact: vi.fn(),
  };
}

beforeEach(() => {
  relayHarness.instances.length = 0;
  meshHarness.instances.length = 0;
  skillHarness.deploy.mockClear();
  skillHarness.undeploy.mockClear();
  toolsHarness.register.mockClear();
});

describe("off by default (no flags)", () => {
  test("session_start auto-starts NOTHING, undeploys the skill, registers no tools", async () => {
    const { pi, emit } = makePi({});
    extension(pi as never);
    await emit("session_start", {}, makeCtx());

    const relay = relayHarness.instances[0]!;
    const mesh = meshHarness.instances[0]!;
    expect(relay.start).not.toHaveBeenCalled();
    expect(mesh.join).not.toHaveBeenCalled();
    expect(skillHarness.undeploy).toHaveBeenCalled();
    expect(skillHarness.deploy).not.toHaveBeenCalled();
    expect(toolsHarness.register).not.toHaveBeenCalled();
  });

  test("bare /remote-pi with no flags connects BOTH (typing it is explicit intent)", async () => {
    const { pi, run } = makePi({});
    extension(pi as never);
    await run("remote-pi", "");
    const relay = relayHarness.instances[0]!;
    const mesh = meshHarness.instances[0]!;
    expect(relay.start).toHaveBeenCalledTimes(1);
    expect(mesh.join).toHaveBeenCalledTimes(1);
  });

  test("bare /remote-pi respects the launch flags when given", async () => {
    const { pi, run } = makePi({ mesh: true });
    extension(pi as never);
    await run("remote-pi", "");
    const relay = relayHarness.instances[0]!;
    const mesh = meshHarness.instances[0]!;
    expect(mesh.join).toHaveBeenCalledTimes(1);
    expect(relay.start).not.toHaveBeenCalled();
  });
});

describe("flag-gated auto-start", () => {
  test("--relay starts only the relay", async () => {
    const { pi, emit } = makePi({ relay: true });
    extension(pi as never);
    await emit("session_start", {}, makeCtx());
    const relay = relayHarness.instances[0]!;
    const mesh = meshHarness.instances[0]!;
    expect(relay.start).toHaveBeenCalledTimes(1);
    expect(mesh.join).not.toHaveBeenCalled();
    expect(skillHarness.undeploy).toHaveBeenCalled();
  });

  test("--mesh joins the mesh, deploys the skill, registers the tools", async () => {
    const { pi, emit } = makePi({ mesh: true });
    extension(pi as never);
    await emit("session_start", {}, makeCtx());
    const relay = relayHarness.instances[0]!;
    const mesh = meshHarness.instances[0]!;
    expect(mesh.join).toHaveBeenCalledTimes(1);
    expect(relay.start).not.toHaveBeenCalled();
    expect(skillHarness.deploy).toHaveBeenCalled();
    expect(toolsHarness.register).toHaveBeenCalledTimes(1);
  });

  test("--relay --mesh starts both", async () => {
    const { pi, emit } = makePi({ relay: true, mesh: true });
    extension(pi as never);
    await emit("session_start", {}, makeCtx());
    expect(relayHarness.instances[0]!.start).toHaveBeenCalledTimes(1);
    expect(meshHarness.instances[0]!.join).toHaveBeenCalledTimes(1);
  });

  test("argv backstop works when getFlag is empty", async () => {
    const { pi, emit } = makePi({});
    const argv = process.argv;
    process.argv = [...argv, "--mesh"];
    try {
      extension(pi as never);
      await emit("session_start", {}, makeCtx());
      expect(meshHarness.instances[0]!.join).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = argv;
    }
  });
});

describe("manual commands", () => {
  test("/remote-pi all starts both services regardless of flags", async () => {
    const { pi, run } = makePi({});
    extension(pi as never);
    await run("remote-pi", "all");
    expect(meshHarness.instances[0]!.join).toHaveBeenCalledTimes(1);
    expect(relayHarness.instances[0]!.start).toHaveBeenCalledTimes(1);
    // Manual mesh start also deploys the surface (skill + tools).
    expect(skillHarness.deploy).toHaveBeenCalled();
    expect(toolsHarness.register).toHaveBeenCalledTimes(1);
  });

  test("/remote-pi relay starts only the relay", async () => {
    const { pi, run } = makePi({});
    extension(pi as never);
    await run("remote-pi", "relay");
    expect(relayHarness.instances[0]!.start).toHaveBeenCalledTimes(1);
    expect(meshHarness.instances[0]!.join).not.toHaveBeenCalled();
  });

  test("legacy 'start <mode>' aliases still work", async () => {
    const { pi, run } = makePi({});
    extension(pi as never);
    await run("remote-pi", "start mesh");
    expect(meshHarness.instances[0]!.join).toHaveBeenCalledTimes(1);
    expect(relayHarness.instances[0]!.start).not.toHaveBeenCalled();
  });

  test("/remote-pi stop tears both down", async () => {
    const { pi, run } = makePi({});
    extension(pi as never);
    const relay = relayHarness.instances[0]!;
    const mesh = meshHarness.instances[0]!;
    relay.isStarted = true;
    mesh.isJoined = true;
    await run("remote-pi", "stop");
    expect(relay.stop).toHaveBeenCalledWith("peer_stop");
    expect(mesh.leave).toHaveBeenCalledTimes(1);
  });

  test("/remote-pi pair / devices / revoke delegate to the relay service", async () => {
    const { pi, run } = makePi({});
    extension(pi as never);
    const relay = relayHarness.instances[0]!;
    await run("remote-pi", "pair --ttl 60");
    await run("remote-pi", "devices");
    await run("remote-pi", "revoke abcd1234");
    expect(relay.pair).toHaveBeenCalledWith(expect.anything(), "--ttl 60");
    expect(relay.listDevices).toHaveBeenCalled();
    expect(relay.revoke).toHaveBeenCalledWith("abcd1234", expect.anything());
  });
});

describe("session name binding", () => {
  test("session_info_changed renames the mesh peer (sanitized) and cycles the relay", async () => {
    const { pi, emit } = makePi({});
    extension(pi as never);
    const relay = relayHarness.instances[0]!;
    const mesh = meshHarness.instances[0]!;
    relay.isStarted = true;
    mesh.isJoined = true;
    await emit("session_info_changed", { name: "New Name" }, makeCtx());
    expect(mesh.rename).toHaveBeenCalledWith("New-Name", "/tmp/test");
    expect(relay.stop).toHaveBeenCalledWith("peer_stop");
    expect(relay.start).toHaveBeenCalledTimes(1);
  });

  test("a cleared session name falls back to the cwd leaf", async () => {
    const { pi, emit } = makePi({});
    extension(pi as never);
    const mesh = meshHarness.instances[0]!;
    mesh.isJoined = true;
    await emit("session_info_changed", { name: undefined }, makeCtx());
    expect(mesh.rename).toHaveBeenCalledWith("test", "/tmp/test");
  });
});

describe("session_shutdown", () => {
  test("disposes both services and drops captured ctxs", async () => {
    const { pi, emit } = makePi({});
    extension(pi as never);
    await emit("session_shutdown", {}, makeCtx());
    expect(relayHarness.instances[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(meshHarness.instances[0]!.dispose).toHaveBeenCalledTimes(1);
  });
});
