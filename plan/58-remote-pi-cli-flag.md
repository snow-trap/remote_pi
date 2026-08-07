# Plano 58 — `pi --remote-pi <mesh|relay|both|off>`: flag de CLI para auto-start

**Status:** planejado
**Subprojetos:** `pi-extension/`

## Contexto

Hoje o auto-start do remote-pi no boot do Pi é controlado **apenas** por
configuração de diretório (`<cwd>/.pi/remote-pi/config.json` →
`auto_start_relay`, default `true`). Não existe nenhum parâmetro de CLI do Pi
para decidir, na hora de lançar o processo, o que o remote-pi deve subir:

- mesh local (UDS) só;
- relay (app mobile) só;
- ambos;
- nada.

O usuário pediu um parâmetro próprio do Pi: `--remote-pi`, com valores
`mesh` / `relay` / `both` / `off`.

### Descobertas da pesquisa (o mecanismo já existe no Pi!)

O Pi **já tem suporte nativo a flags de CLI de extensão** — não precisa tocar
no CLI do Pi:

1. `parseArgs` (dist/cli/args.js) coleta flags desconhecidas `--xxx` num Map
   `unknownFlags` (sem rejeitar; `--flag value` e `--flag=value` ambos funcionam).
2. `createAgentSessionServices` (dist/core/agent-session-services.js,
   `applyExtensionFlagValues`) compara essas flags com as registradas pelas
   extensões: se registrada, escreve em `runtime.flagValues`; se **não**
   registrada, emite erro `Unknown option --xxx` e o Pi aborta.
3. API da extensão (dist/core/extensions/types.d.ts:909-919):
   - `pi.registerFlag(name, { description?, type: "boolean"|"string", default? })`
   - `pi.getFlag(name): boolean | string | undefined`
   - `type: "string"` aceita `--remote-pi mesh` (valor no próximo arg) ou
     `--remote-pi=mesh`.
4. A própria extensão já lê `process.argv` para `-p`/`--print` (index.ts:~2390)
   — precedente de que argv é visível ao runtime.

### Tensão de design (decisão registrada)

O flag **só governa o auto-start** (session_start), nunca o comando manual
`/remote-pi` — o usuário que digita o comando explicitamente tem intenção
explícita e deve receber o comportamento completo (wizard/join/relay conforme
config). Separar as duas vias evita surpresa ("`--remote-pi off` quebrou meu
`/remote-pi` manual").

Prioridade de resolução: **flag CLI > config local > default** (o flag é
read-only, nunca persiste em config.json).

Valores inválidos (`--remote-pi bogus`): aviso via notify + fallback para o
comportamento atual (mesmo de não ter passado o flag).

## Semântica

| Flag | Auto-start no boot | Notas |
|---|---|---|
| *(não passado)* | join mesh; relay se `auto_start_relay` (default true) | comportamento atual, inalterado |
| `both` | idem | forma explícita do default |
| `mesh` | só join mesh, relay NÃO sobe | mesmo caminho de lock/nome do auto-start atual, só pulando o `_cmdStart` |
| `relay` | só relay (canal app), mesh NÃO é joinado | `_cmdStart` já é independente do mesh (canal app + control path); bridge cross-PC fica naturalmente inativa sem broker |
| `off` | nada sobe | mais forte que `auto_start_relay=false` (que ainda faz join) |

- Daemon (`REMOTE_PI_DAEMON=1`, supervisor) e Cockpit não passam o flag →
  comportamento inalterado.
- `-p`/`--print` continua pulando auto-start em qualquer modo.
- Modo `mesh` sem config local (dir novo): faz join direto com nome default
  (não roda wizard). Com config, passa pelo `_cmdRoot` (ganha cwd-lock).

## Passos

### 1. Registrar o flag + parser puro

- `pi-extension/src/index.ts` na factory (`extension: ExtensionFactory`):
  `pi.registerFlag("remote-pi", { type: "string", description: "Auto-start mode for remote-pi: mesh | relay | both | off" })` —
  **sem** `default` (undefined = "não passado", preserva a config).
- Parser puro exportado (para teste): `resolveCliRemotePiMode(argv?): "mesh" | "relay" | "both" | "off" | undefined`
  - lê `--remote-pi` / `--remote-pi=<v>` de `argv ?? process.argv`;
  - valor fora do enum → `undefined` + log de aviso (o notify de UX acontece no
    call site, com o valor inválido para a mensagem).

### 2. Gate no auto-start (session_start, index.ts ~2384)

No bloco existente (que já trata `isPrintMode` / daemon / `localConfigExists`):

- `off` → não inicia nada (marca `_autoInited`; a decisão é por processo).
- `both`/undefined → caminho atual (`_cmdRoot` com `effectiveAutoStartRelay`).
- `mesh` → se `localConfigExists(cwd)`: `_cmdRoot` com relay forçado off
  (ver passo 3); senão: `_cmdJoin` direto (ctx do initCtx).
- `relay` → `_cmdStart(initCtx)` direto (notify com "relay-only, mesh off").
- `isPrintMode` continua dominando (qualquer modo → skip).

### 3. `mesh` força relay off dentro do `_cmdRoot`

- Estado de módulo `_cliAutoMode` (setado no passo 2 antes de chamar `_cmdRoot`).
- Em `_cmdRootInner`, o gate do relay vira
  `effectiveAutoStartRelay(config) && _cliAutoMode !== "mesh"`.
- Assim `mesh` reusa lock/join/nome/#N sem duplicar o fluxo.

### 4. Testes

- Parser: valores válidos/inválidos/`=`/ausente (arquivo de teste do parser ou
  bloco em `config.test.ts`).
- Auto-start: estender `extension.test.ts` (padrão existente de mock de
  `session_start`) cobrindo `off` (nada sobe), `mesh` (join sim, relay não) e
  `relay` (relay sim, join não); confirmar que `both`/ausente mantêm o
  comportamento atual e que `/remote-pi` manual não é afetado.

### 5. Docs

- `pi-extension/README.md`: seção curta "CLI flag" com a tabela de semântica
  e a precedência flag > config > default.

## Critérios de aceite

- [ ] `pi --remote-pi off` → boot sem mesh e sem relay; `/remote-pi` manual
      continua funcionando.
- [ ] `pi --remote-pi mesh` → peers locais visíveis (`list_peers`), footer sem
      `🟢 relay`; config `auto_start_relay:true` não sobe relay.
- [ ] `pi --remote-pi relay` → relay sobe (room no app), sem peer mesh; sem
      config local também sobe.
- [ ] `pi --remote-pi both` ≡ sem flag (default atual).
- [ ] `pi --remote-pi bogus` → aviso + comportamento de não-passado.
- [ ] `pi -p --remote-pi both "prompt"` → não sobe nada (print mode).
- [ ] Daemon via supervisor (sem flag) → inalterado.
- [ ] Testes unitários verdes; `npm test` do pi-extension passa.

## DoD

- [ ] Flag registrado e parser puro testado
- [ ] Auto-start com os 4 modos + interação print/daemon cobertos por teste
- [ ] README atualizado
- [ ] Commit Conventional Commits (`feat(pi-extension): ...`) na branch
      `feat/remote-pi-cli-flag`, sem push

## Próximos planos possíveis

- Flag `--remote-pi-relay-url` (override de relay sem env var).
- Expor o modo no `/remote-pi status` (ex.: `mode: mesh (CLI flag)`).
