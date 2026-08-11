<p align="center">
  <img src="https://raw.githubusercontent.com/jacobaraujo7/remote_pi/main/branding/logo-full.svg" width="160" alt="Remote Pi logo" />
</p>

<h1 align="center">Remote Pi</h1>

> Extend the [Pi coding agent](https://github.com/earendil-works/pi) with two
> superpowers: agents that talk to each other on the same machine, and a mobile
> app that drives Pi from your phone.

**This is the lean rewrite** (`rewrite/lean-remote-pi`): only the relay
(phone remote control) and the mesh (local agent network) remain, both
**off by default**. The daemon fleet, MCP server, Cockpit integration,
pi-ask bridge, setup wizard and all local JSON config files are gone.

## Protocol & Security

For wire format, identity model, ACK protocol, cross-PC routing, mesh
membership, and the trust model, read [`PROTOCOL.md`](../PROTOCOL.md) at the
repo root. It is the canonical document — this README only covers setup.

---

## Quick start

Install the extension (one-time):

```bash
pi install npm:remote-pi
```

Then pick what you want, per launch:

```bash
pi --relay          # phone app channel (pair via QR)
pi --mesh           # local agent mesh (agent_send / list_peers)
pi --relay --mesh   # both
pi                  # neither — the extension is fully inert
```

or at runtime, from any Pi session:

```text
/remote-pi start relay      # just the relay
/remote-pi start mesh       # just the mesh
/remote-pi start all        # both
/remote-pi stop             # tear everything down
/remote-pi status           # two-line state snapshot
```

With no flags and no manual `start`, remote-pi does **nothing**: no sockets,
no WebSocket, no tools, no skill, no footer — zero footprint.

## The mesh name is the session name

Your mesh identity is your **Pi session name** (the one `/session` shows and
edits), falling back to the folder's basename. Rename the session and the
mesh follows live; the relay room follows too. There is no separate
`agent_name` setting, no wizard, no rename command.

Same-named agents in the same folder coexist via a runtime `#N` suffix
(`backend#2`). The suffix is never persisted — restart and you're back to the
clean name if it's free.

## The relay URL

Resolution order, no config file:

1. `REMOTE_PI_RELAY` environment variable
2. the built-in community default (`https://relay-rp1.jacobmoura.work`)

Self-hosters: `export REMOTE_PI_RELAY=https://your-relay.example` (http(s)
form; the extension upgrades to ws(s) internally).

## Pairing a mobile device

```text
/remote-pi pair            # show a QR (TUI entry — never sent to the LLM)
/remote-pi devices         # list paired devices
/remote-pi revoke <shortid>
```

The QR / pairing code is rendered as a **custom entry**: visible in the
terminal, but it never enters the model's context. In fact the only thing
this extension ever injects into the LLM context is an inbound mesh message
(`remote-pi:mesh-message`) — that one IS the feature.

## Agent network

With `--mesh` on, the LLM gets two tools plus the `agent-network` skill:

- `list_peers()` — opaque routing addresses (`<cwd>@<name>`, cross-PC peers
  prefixed `<pc>:`)
- `agent_send({ to, body, re? })` — unicast with broker ACK
  (`received | denied | timeout`), broadcast/multicast fire-and-forget

Inbound mesh messages arrive as turn input. Reply with `agent_send` and echo
the incoming `id` as `re`. Cross-PC routing rides the relay when both
`--relay` and `--mesh` are up; mesh-only degrades to the local machine.

## Mobile app actions

The paired app can: send prompts (with images), steer a running turn, cancel,
sync history, and run Quick Actions — new session, compact, set model, set
thinking level. Every connected owner sees the same live stream.

## State on disk (no config files)

`~/.pi/remote/` holds runtime **state** only: `peers.json` (paired devices),
the Ed25519 identity (system keyring, file fallback), broker sockets and
`audit.jsonl`, plus the deployed skill. There is no remote-pi config file
anywhere — flags at launch, env var for the relay URL, session name for the
mesh name.

## License

[MIT](./LICENSE)
