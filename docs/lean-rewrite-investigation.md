# 精简版 remote-pi 重写——现状调查基线

> 分支：`rewrite/lean-remote-pi`（基于 `main` = `ce1887f`，2026-08 复核）
> 目的：把重写前的调查结论沉淀为文档，作为裁剪/重设计的依据。
> 基线说明：`main` **已合并** issue #105 修复（`e82b979`）与 `--remote-pi`
> flag（`be032eb`，plan/58）；上游 `jacobaraujo7:main` 的合并仅动 cockpit，
> 未触及 pi-extension。本文件为复核后的最新状态。

---

## 1. 现状架构：三层结构

### 1.1 本地 UDS mesh（核心，零依赖）

- `SessionPeer` + `Broker`：Unix domain socket broker，`~/.pi/remote/sessions/<name>/broker.sock`
- 完全独立于 relay：`_cmdJoin` 创建 `MeshNode` 时不带任何 relay 参数
- broker 负责：路由（不透明 `to` 地址）、ACK、广播 `peer_joined/peer_left`、
  名字冲突 `#N` 后缀、leader failover、`audit.jsonl`
- leader 门控：只有 leader 能建跨 PC 桥

### 1.2 relay 的 app 通道（独立于 mesh）

- `RelayClient`（WebSocket）+ auto-listener + `PlainPeerChannel`
- `_cmdStart` 不检查 `_meshNode` → **relay-only 运行态存在**（Cockpit 控制消息就是 relay-only）
- 功能：手机 app 配对/消息/快照/图片、Quick Actions（model/thinking/compact/new）

### 1.3 跨 PC 桥（唯一的真耦合点）

- `attachCrossPcBridge` → `BrokerRemote` + `PiForwardClient`
- 依赖：leader 的本地 broker + relay WS + Ed25519 身份 + 拓扑快照
- 特性：leader-only、failover 自动重挂、断线降级不影响 UDS mesh、两种生命周期
  （pi 主路径注入式 / MCP 路径自管理式 `MeshSelfRelayBridge`）
- 拓扑发现（`MeshClient` over relay）依赖 relay 在线

**结论：mesh 与 relay 不是深度耦合。** 唯一咬合点是 leader 上的跨 PC 桥，
刻意做成"断了降级、failover 重挂、失败不影响 UDS"。relay 对 mesh 是浅依赖
（桥需要 broker），mesh 对 relay 零依赖。

---

## 2. 已知问题（重写必须处理的卫生问题）

### 2.1 提示词注入面（LLM context 泄漏）

机制：Pi 把所有 custom message 持久化为 `CustomMessageEntry` 并**每 turn 注入
LLM context**；`display:false` 只隐藏 TUI，**不挡注入**（#105 教训）。
当前 `pi.on("context")` 只过滤 `remote-pi:received-image`。

| custom 类型 | display | 状态 | 问题 |
|---|---|---|---|
| `remote-pi:relay-state` | false | ✓ 已抑制（默认） | `_dataEventsEnabled()` 裁剪，仅控制通道 `force=true` 响应 |
| `remote-pi:name-assigned` | false | ✓ 已抑制（rename + join 两处都包裹） | 同上 |
| `remote-pi:paired` | false | ✓ 已抑制 | 同上 |
| `remote-pi:pair-code` | true | ✗ **唯一遗留** | 每次配对注入整块 QR ASCII + pairing URI（几十行展示文本），对 LLM 零价值，未被 #105 覆盖 |
| `remote-pi:received-image` | — | ✓ 已过滤 | context hook 裁剪 |
| `remote-pi:mesh-message` | true | 有意 | mesh 通信核心，但**任何 peer 文本直接进 context、无内容过滤**——最暴露的注入面（协议 trust model） |
| `remote-pi:mesh-revoked` | true | 有意 | 安全通知，低频 |

已修复方案（已合入 main）：`_dataEventsEnabled()` =
`loadConfig().suppress_data_events === false`，默认裁剪 relay-state/name-assigned/paired
三个纯数据事件。**重写必须内置此机制，且所有未来纯数据事件默认走抑制通道。**

### 2.2 skill 可见性（off 模式不隐身）

- `_deployAgentNetworkSkill()` + `pi.on("resources_discover")` 在 factory 无条件执行
- `--remote-pi off` 只门控 session_start auto-start；skill 照常部署/暴露，
  工具照常注册（调用时返回 `refused: "Not in a session. Run /remote-pi join first"`）
- 若 off 要完全隐身：resources_discover 按模式返回空 + 跳过部署

### 2.3 代码臃肿

1. **~90 行完全重复**：`session/bridge.ts` 与 `session/mesh_node.ts` 各有一份
   `compareAscii` / `validateAlias` / `validateLegacyPcLabel` / `ownTopology`
   （bridge.ts:51-85 vs mesh_node.ts:66-130）→ 抽共享 `mesh/topology.ts`
2. **index.ts 5279 行**巨型文件：状态机/命令/配对/图片/daemon/cron/MCP 全混合
3. **23 处 `_xxxForTest` exports** 混在生产模块

---

## 3. 已实现特性（均已合入 main）

### 3.1 `--remote-pi <mesh|relay|both|off>`（plan/58，已合入 main）

- Pi 原生支持扩展注册 flag：`pi.registerFlag("remote-pi", { type: "string" })`
  + `pi.getFlag()`；未注册 flag 会被 Pi CLI 拒绝（`Unknown option`）
- 语义：只门控 session_start auto-start；手动 `/remote-pi` 不受影响
- `off`（什么都不启）/ `mesh`（只 join，relay 强制关）/ `relay`（只 relay，
  `_cmdStart` 不依赖 mesh）/ `both` 或不传（现行为）
- 实现：`cliRemotePiValue`/`resolveCliRemotePiMode` 纯函数 + auto-start 分支
  派发 + `_cmdRoot(ctx, restartAuthority, cliAutoMode)` 参数化 relay 门控
- 测试：parser 单测 + auto-start 分派（extension.test.ts），801 全绿

### 3.2 issue #105 修复（已合入 main）

- `suppress_data_events`（`~/.pi/remote/config.json`，默认 true）→
  `_dataEventsEnabled()` 裁剪 relay-state/name-assigned/paired 三个纯数据事件
- 显式控制通道查询（`force=true`）仍响应

---

## 4. 精简版重写建议（裁剪清单）

### 4.1 建议保留（核心价值）

- UDS mesh（SessionPeer/Broker）：地址寻址、ACK、failover、`#N`、audit
- agent-network skill + `list_peers`/`agent_send`（事件驱动协议）
- relay app 通道（配对、消息流、Quick Actions）——若保留手机端
- `--remote-pi` flag 的 auto-start 门控

### 4.2 建议裁剪/简化（按代码量与价值权衡）

| 候选 | 现状 | 裁剪理由 |
|---|---|---|
| daemon 舰队（supervisor/cron） | 独立模块 ~2000 行 | 与核心 mesh/app 正交，可拆为独立包 |
| 跨 PC 桥（BrokerRemote/PiForward/SelfRevoke） | 复杂拓扑/身份逻辑 | 本地单机场景可先砍，保留扩展点 |
| 图片通道（接收/预览/缓存） | ~400 行 | 边缘功能，可后置 |
| Cockpit 纯数据事件（relay-state 等） | 3 处 sendMessage | 重写默认抑制，或砍掉改由控制通道轮询 |
| MCP 自管理桥（MeshSelfRelayBridge） | MeshNode 内两套生命周期 | 与注入式合并为一种 |

### 4.3 重写必须内建的卫生规则

1. 所有 custom message 默认走 `suppress` 通道；`display:false` 不等于不进 context
2. 纯展示内容（QR、状态）用 `ctx.ui`/entry renderer，不注入 context
3. skill 部署与 tools 注册跟随 auto-start 模式（off = 完全隐身）
4. topology 校验函数只写一份（共享模块）
5. 不在生产模块放 test-only exports（用 `vi.mock` 或依赖注入）

---

## 5. 分支与提交地图（复核后）

| 分支 | 内容 | 状态 |
|---|---|---|
| `main` | `ce1887f` = 基线 + #105 修复（`e82b979`）+ plan/58（`be032eb`）+ 上游 jacobaraujo7:main 合并（仅 cockpit） | 已推送 |
| `fix/105-stop-pure-data-context-leak` | #105 修复 + dist | 已合并入 main |
| `feat/remote-pi-cli-flag` | plan/58 `--remote-pi` flag（含 plan 文档） | 已合并入 main |
| `rewrite/lean-remote-pi` | 本文档 | 当前 |
