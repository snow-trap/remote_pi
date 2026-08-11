# Remote Pi — Pi Extension (Node + TypeScript)

Lean rewrite: extensão para o [Pi coding agent](https://github.com/earendil-works/pi)
com **apenas dois recursos**, ambos **desligados por padrão**:

- **relay** (`pi --relay` ou `/remote-pi start relay`) — canal do app móvel
  (pareamento QR, stream ao vivo, Quick Actions)
- **mesh** (`pi --mesh` ou `/remote-pi start mesh`) — rede local de agentes
  via broker UDS (`agent_send` / `list_peers` + skill `agent-network`)

Sem flags e sem `start` manual a extensão é totalmente inerte (sem tools,
sem skill, sem footer). Protocolo, identidades, ACK, roteamento cross-PC e
trust model: [`../PROTOCOL.md`](../PROTOCOL.md).

## Arquitetura

```
src/
  index.ts            # casca fina: factory, flags, wiring de eventos, comandos
  flags.ts            # parsing de --relay/--mesh (funções puras)
  wake.ts             # wrapper de pi.sendUserMessage
  relay/              # RelayService + transporte/pareamento/protocolo/ações
  mesh/               # MeshService + broker/peer/bridge cross-PC/tools/skill
  ui/footer.ts        # status bar
```

Regras duras da rewrite:

- **Estado vive nas instâncias** `RelayService`/`MeshService` criadas na
  factory — nada de singletons mutáveis no escopo do módulo.
  `session_shutdown` → `dispose()`.
- **Higiene de contexto LLM**: o único custom message injetado no contexto é
  `remote-pi:mesh-message` (é o próprio mesh). Artefatos de UI (QR de
  pareamento, aviso de revoke) usam `appendEntry` + `registerEntryRenderer` —
  visíveis no TUI, nunca no contexto. Previews de imagem recebida são
  filtrados nos hooks `context`/`session_before_compact`.
- **Nome do mesh = nome da sessão Pi** (`pi.getSessionName()`), fallback
  `basename(cwd)`. `session_info_changed` → rename no broker. Sufixo `#N` de
  colisão é resolução de runtime — nunca persistido.
- **Sem arquivos de config JSON**: relay URL = `REMOTE_PI_RELAY` env ou
  default embutido; auto-start = flags; nome = sessão. `~/.pi/remote/` guarda
  só estado (peers.json, identidade Ed25519, sockets, audit, skill).
- Testes instanciam os services diretamente — não existe `_xxxForTest`.

## Stack

- Node 20+ / TypeScript 6, ESM only (NodeNext, imports com `.js`)
- Package manager: **pnpm**
- Crypto: `@noble/ed25519` (identidade Pi) — storage via `@napi-rs/keyring`
  (Keychain / libsecret / Credential Manager; headless cai pra
  `~/.pi/remote/identity.json` com `chmod 0600`)

## Comandos

- `pnpm install` / `pnpm typecheck` / `pnpm test` / `pnpm build`
- `pnpm build` gera `dist/` — **dist é comitado** (permite
  `pi install git:…` sem etapa de build)

## Convenções

- **Strict TS** (`"strict": true`), `unknown` + narrow em vez de `any`
- Erros nomeados `class XxxError extends Error`, throw cedo no boundary
- Não escrever CommonJS; não introduzir dependência não-ESM

## Modo orquestrado

Se receber um prompt começando com `[ORCH:<task-id>]`, leia
`../.orchestration/INSTRUCTIONS.md` antes de qualquer outra ação.
