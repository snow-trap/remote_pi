# Plan 59 — Lean Rewrite: remote-pi 极简版

> 分支：`rewrite/lean-remote-pi`
> 依据：[`docs/lean-rewrite-investigation.md`](../docs/lean-rewrite-investigation.md)
> 范围：**只动 `pi-extension/`**；monorepo 其他子项目（app/relay/site/cockpit）不动。

## 目标

把 pi-extension 重写为极简版，只保留两个功能域：

- **relay** — 手机 app 远程控制通道（配对、消息流、Quick Actions）
- **mesh** — 本地 UDS agent 网络（broker、peer、`agent_send`/`list_peers`、agent-network skill）

硬约束（来自需求）：

1. 仅保留 relay 和 mesh 功能，其余全砍
2. 两个功能**默认关闭**；不传 flag 时扩展完全静默
3. `pi --remote-pi <mode>` 改为两个 boolean flag：`--relay` + `--mesh`
4. mesh 名字 = pi session 名字，无独立配置通道（删 `agent_name`、setup wizard、rename 命令）
5. 删除 local JSON 配置文件（`.pi/remote-pi/config.json`、`~/.pi/remote/config.json`），只保留必要运行时状态
6. 敢于大架构变更
7. 顺带清理功能冗余、代码冗余、提示词注入冗余

## 架构决策（大变更）

### D1. 模块级全局单例 → 工厂作用域服务实例

现状：`index.ts` 5419 行，约 40 个模块级 `let` 变量（`_state`/`_relay`/`_meshNode`/`_activePeers`/…）。
jiti `moduleCache:false` 导致每次 session 替换重新评估模块，全局状态与 OS 句柄脱节，
是历史 bug 温床（double-connect、stale ctx、generation 计数器补丁摞补丁）。

新架构：两个内聚服务类，在 extension factory 闭包内 `new`，`session_shutdown` 时 dispose：

```
src/
  index.ts               # 薄壳（目标 <400 行）：factory、flag 注册、事件接线、命令注册
  flags.ts               # --relay/--mesh 解析（纯函数）
  relay/
    relay_service.ts     # RelayService：connect/pair/revoke/reconnect/路由/广播
    client.ts            # RelayClient（WS 传输）          ← transport/relay_client.ts
    peer_channel.ts      # PlainPeerChannel                ← transport/peer_channel.ts
    pairing.ts           # QR + token session              ← pairing/qr.ts + crypto.ts
    storage.ts           # peers.json + Ed25519 身份       ← pairing/storage.ts
    protocol.ts          # ClientMessage/ServerMessage     ← protocol/types.ts + codec.ts
    actions.ts           # Quick Actions                   ← actions/handlers.ts + registry.ts
    rooms.ts             # roomIdFor                       ← rooms.ts
  mesh/
    mesh_service.ts      # MeshService：join/leave/rename/投递 drain/skill 部署
    node.ts              # MeshNode（删跨 PC 桥后精简）     ← session/mesh_node.ts
    broker.ts            # UDS broker                      ← session/broker.ts
    peer.ts              # SessionPeer                     ← session/peer.ts
    envelope.ts          # 信封 + ACK                      ← session/envelope.ts
    ipc.ts               # POSIX sock / Windows named pipe ← session/ipc.ts
    cwd_lock.ts          # per-(cwd,name) 锁               ← session/cwd_lock.ts
    leader_election.ts                                    ← session/leader_election.ts
    paths.ts             # ~/.pi/remote/sessions 路径       ← session/global_config.ts
    tools.ts             # agent_send + list_peers          ← session/tools.ts（删 agent_request）
  ui/
    footer.ts            # 状态栏                           ← ui/footer.ts
```

效果：
- 23 个 `_xxxForTest` export 消失 —— 测试直接实例化服务类
- generation/stale-authority 补丁逻辑大幅简化（实例随 session 生死）
- daemon 分支（`REMOTE_PI_DAEMON`）随 daemon 功能一起删除

### D2. Flag 语义（需求 2+3）

```ts
pi.registerFlag("relay", { type: "boolean", description: "…" });
pi.registerFlag("mesh",  { type: "boolean", description: "…" });
```

| 启动方式 | relay | mesh |
|---|---|---|
| `pi`（无 flag） | 关 | 关（完全静默：不 auto-start、不部署 skill、不注册工具） |
| `pi --relay` | 开 | 关 |
| `pi --mesh` | 关 | 开 |
| `pi --relay --mesh` | 开 | 开 |

- flag 只门控 **session_start auto-start**；手动命令不受限（沿用 plan/58 语义）
- `pi -p/--print` 永不 auto-start（issue #44 修复保留）
- 手动命令面（精简后）：
  - `/remote-pi start [relay|mesh|all]` — 无参 = 按 flag 启动已选功能；带参 = 强制启动指定功能
  - `/remote-pi stop`、`/remote-pi status`
  - `/remote-pi pair [--ttl N]`、`/remote-pi devices`、`/remote-pi revoke <shortid>`
  - 删除：setup / rename / set-relay / peers / create / remove / daemons / daemon * / cron / install / uninstall

### D3. mesh 名字 = session 名字（需求 5）

- join 时 `name = pi.getSessionName() ?? basename(cwd)`（sanitizeSegment 规则保留）
- `session_info_changed` 事件 → `MeshNode.rename()` 跟随（sanitize 后为空则忽略）
- broker 冲突分配 `#N` 后缀 → **不回写 session 名**（用户授权我决定）：`#N` 是运行时
  冲突解析，化石进 session 文件会导致名字漂移（`name#2#2`，plan/38 decision E 的教训）。
  通过 footer + notify 告知实际 mesh 名即可
- 删除：`agent_name` 配置、setup wizard、`/remote-pi rename`、名字迁移逻辑

### D4. 配置删除（需求 6）

| 现状 | 去向 |
|---|---|
| `~/.pi/remote/config.json`（relay URL、suppress_data_events） | **删除**。relay URL = `REMOTE_PI_RELAY` env > 内置默认；suppress 机制随 Cockpit 事件消失 |
| `<cwd>/.pi/remote-pi/config.json`（agent_name、auto_start_relay） | **删除**。auto-start 由 flag 替代 |
| `REMOTE_PI_DIRECT_CONFIG` env | 删除（daemon 专用） |
| peers.json、Ed25519 身份、sessions/*.sock、audit.jsonl、cwd locks | **保留**（运行时状态，非配置） |

### D5. 提示词注入卫生（需求 8）

原则：**扩展默认不向 LLM context 注入任何东西**，唯一例外是 mesh 消息本身。

| custom message | 现状 | 重写 |
|---|---|---|
| `remote-pi:mesh-message` | display:true，进 context | **保留**（mesh 核心功能，有意注入） |
| `remote-pi:pair-code`（QR ASCII） | display:true，进 context（#105 遗留） | 改为 `appendEntry` + `registerEntryRenderer` —— TUI 可见，**永不进 context** |
| `remote-pi:relay-state` / `name-assigned` / `paired` | display:false + suppress 配置 | **随 Cockpit 集成整体删除**（用户确认不用 Cockpit）——suppress 机制与 config.json 一并消失 |
| `remote-pi:received-image` | context hook 过滤 | **保留**（图片通道用户确认保留），context/compact 过滤器随之保留 |
| `remote-pi:mesh-revoked` | display:true | **保留**（跨 PC 桥保留，安全通知低频） |

### D6. 砍掉清单（已与用户确认）

| 模块 | 行数（约） | 理由 |
|---|---|---|
| `daemon/` 全部 + `bin/supervisord.ts` + `service-templates/` | 2600 | 与核心正交（调查 4.2） |
| `mcp/` 全部 + `remote-pi claude` 命令 | 400 | **用户确认砍**：Claude 接入后置；`MeshSelfRelayBridge`（MCP 专用桥生命周期）随之删除 |
| `extension_ui_bridge.ts`（pi-ask） | 430 | 第三方集成 |
| `session/setup_wizard.ts`、`local_config.ts`、`session/wizard.ts` | 320 | 见 D3/D4 |
| `peer_inventory.ts`、`/remote-pi peers` | 120 | `list_peers` 工具覆盖 |
| `install.sh` | — | daemon 安装脚本，随 daemon 删除 |
| 依赖：`@modelcontextprotocol/sdk`、`croner`、`zod` | — | 随 mcp/cron 删除 |
| 全部可删命令：setup / rename / set-relay / peers / create / remove / daemons / daemon * / cron / install / uninstall | — | **用户确认** |

**保留（用户确认）**：跨 PC 桥（`session/bridge.ts`、`broker_remote.ts`、`pi_forward_client.ts`、
`mesh/{self_revoke,siblings,verify,canonical,client,types,encoding}.ts`）与图片通道。
桥保持现有"断了降级、failover 重挂"语义：`--mesh` 单独使用时桥不起（无 relay），自然降级单机。
调查 2.3.1 的 ~90 行重复（`compareAscii`/`validateAlias`/`validateLegacyPcLabel`/`ownTopology`，
bridge.ts vs mesh_node.ts 各一份）抽为共享 `mesh/topology.ts`（需求 8 代码冗余）。

### D7. off 模式完全隐身

- 不传 flag：不部署 skill、不注册工具、不 auto-start、footer 不显示
- skill 部署跟随 mesh 启用：启用时部署 `~/.pi/remote/skills/agent-network/SKILL.md`；
  factory 启动时若 mesh off 则**删除**已部署文件（保证 off = 隐身）
- 手动 `/remote-pi start mesh` 运行时注册工具（`registerTool` post-bind 合法，SDK 自动 refresh）
- SKILL.md 内容精简：删掉 Claude/MCP/`get_messages` 章节

## Cockpit 集成（已确认：砍）

用户不用 Cockpit 桌面 app。删除：CTRL_PREFIX 控制通道、3 个纯数据事件、
`_controlCtx`/`_headlessUi` 支撑代码、`extension_ui_bridge.ts`（pi-ask）。
背景：手机 app 走扩展自持的 relay WebSocket（带外通道，与 session 消息系统物理隔离）；
Cockpit 是 pi RPC 宿主，唯一出口是 session 消息流（带内 = LLM context）。砍掉后
消息消费者只剩手机（WS）与 LLM（mesh-message，有意注入），不存在抑制问题。

## 测试策略

- **删除**：`extension.test.ts`（6043 行，大部分测被砍功能）、daemon/mcp/桥/图片相关全部测试、`e2e.test.ts`
- **保留并修剪**：broker / peer / envelope / cwd_lock / leader_election / ipc / relay_client / peer_channel / pairing(storage,qr) / rooms / codec / actions
- **新增**：
  - flags 解析 + session_start 门控分派（无 flag = 无 auto-start、无工具、无 skill）
  - 注入卫生：pair QR 走 entry renderer（不进 context）；custom message 白名单只有 mesh-message
  - session name 同步（join 用 session name、rename 跟随、#N 回写防循环）
  - RelayService / MeshService 生命周期（start/stop/dispose 幂等）

## 执行步骤

1. 新骨架：`flags.ts`、目录结构、服务类抽取
2. 移植 mesh（删桥后的 node.ts）+ 工具 + skill
3. 移植 relay（删图片/Cockpit/pi-ask）+ 配对 + Quick Actions
4. 薄壳 index.ts：flag 注册、事件接线、命令面、session name 同步
5. 删除清单执行（文件、依赖、package.json bin、install.sh）
6. 测试修剪 + 新增，`vitest` 全绿
7. `tsc` build，提交 `dist/`（repo 惯例：`pi install git:…` 免构建）
8. 更新 `pi-extension/README.md`（精简）；`docs/daemon.md` 删除；PROTOCOL.md 标注被砍部分
9. Conventional Commits：`refactor(extension): …` 系列提交

## DoD

- [ ] `pi`（无 flag）启动：无 relay、无 mesh、无工具、无 skill、无 footer 残留
- [ ] `pi --relay`：relay 自动连接，可配对；mesh 工具不存在
- [ ] `pi --mesh`：加入本地 mesh，`agent_send`/`list_peers` 可用，skill 可见
- [ ] `/remote-pi start all` 在无 flag 会话里手动拉起两者
- [ ] mesh 名 = session 名；pi 内改名 → mesh 跟随；`#N` 冲突 → session 名回写
- [ ] 无任何 local JSON 配置文件读写；`~/.pi/remote/` 只剩 state
- [ ] LLM context 中除 mesh 消息外无扩展注入（含 pair QR）
- [ ] `pnpm typecheck && pnpm test && pnpm build` 全绿，dist 已提交
- [ ] 代码总量：src/ 非测试行数从 ~21k 降到 ~10k 以内（桥 + 图片通道保留）
