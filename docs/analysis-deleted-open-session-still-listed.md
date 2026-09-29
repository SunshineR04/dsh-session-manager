# 分析：彻底删除后，被删会话仍出现在侧边栏「未分组」

- 日期：2026-09-29
- 环境：dsh `0.2.0-rc.2`（web profile，`~/.dsh/profiles/web`，插件以 `link:` 指向本仓库，版本 `0.3.9`）
- 触发动作：上下文菜单 →「彻底删除」
- 现象：删除后该会话出现在侧边栏 `未分组` 分组下（截图标题「请调用一次 web_search, …」与「未命名」）
- 结论：**删除是成功的，残留的是官方归档视图下的"内存墓碑"**，不是 dsh 更新引入的行为回归

---

## 1. 结论（TL;DR）

对**处于打开状态**的会话执行彻底删除时，插件只能做到：

1. 删除磁盘产物（会话目录 + projcache）——已完成；
2. 从工作区记账中摘除（`detachSession`）——已完成；
3. 在 registry 的 `archivedSessionIds` 里留一个**墓碑**，并广播 `api-session/removed`（`lib/index.js:552-646`，墓碑分支 `606-611`）。

dsh 进程内的那个会话对象**无法关闭**（无公开 API），于是：

- `session/list` 永远继续返回它（`dsh-api-session-controller/lib/index.js:1888-1906`：live 会话走 `summaryFor(live)`）；
- dsh 的会话查询层同样从 `ctx.sessions.list()` 生成 live 行（`dsh-session-query-sqlite/lib/index.js:741-753`），所以只要有内存副本就有记录；
- 任何一次客户端列表拉取（页面加载、重连，以及插件自己的"删除后刷新"`lib/client.js:1053-1076`）都会把这个 id 重新灌回客户端列表 store；
- **唯一让它不可见的机制就是"官方归档过滤器"**：`sessionVisible()` 在 `archivedFilter === 'default'`（隐藏已归档）时过滤归档 id（`dsh-client-ui-workspace/lib/client.js:357-367`）。

因此一旦侧边栏切到 `视图选项 → 全部对话（显示已归档）` 或 `仅显示已归档`，这个"未被任何工作区记账 + 已归档"的残留就会被渲染进 `未分组`（`client.js:420-439` 的 stray 分支），看起来就像"删掉的会话又回来了"。

---

## 2. 证据

### 2.1 主机仍在返回被删会话（只读 API 实测）

对运行中的实例调用 `POST /api/session/list`（`payload: { args: { _request: {} } }`），返回 56 条，其中包含两个已删 id：

| sessionId | 磁盘产物 | 仍在 `session/list` |
|---|---|---|
| `session-a56c3963-0f1d-4283-880c-94d40e5fc22d` | 已删除 | 是 |
| `session-f4a72b82-5b6f-4685-b2cd-0ed92a956a11` | 已删除 | 是 |

同时 `~/.dsh/storages/`：

- `workspace.json → global.archivedSessionIds` 恰好等于这两个 id（墓碑）；
- `session-manager.pending.json → sessionIds` 也恰好是这两个 id（等待下一次启动收尾的队列）。

这三者同时成立，正好说明删除走的是"打开中的会话"分支（tombstone + pending），而不是冷会话分支。

### 2.2 客户端明明知道它们是"已归档"，只是视图允许显示

对用户提供截图逐像素采样（`未分组` 标签 vs 两条会话标题）：

| 区域 | 最暗像素亮度 | 判定 |
|---|---|---|
| 「未分组」标签 | 28（≈ `rgb(28,28,30)`，正常文字色） | 普通行 |
| 第 1 行标题 | 177（无任何 <120 的像素） | 官方归档行暗色 `rgb(173,178,184)` |
| 第 2 行标题 | 177 | 同上 |
| 时间戳 | 135 | 次色 |

在运行实例上对照确认：被删（墓碑）行带官方样式类 `YDXeBa_archived`、文字色 `rgb(173,178,184)`；正常行是 `rgb(28,28,30)`。

**推论**：如果客户端的归档集合里没有这两个 id（即"客户端状态过期"），这两行会以**正常颜色**渲染。截图里是归档色 → 客户端**持有**墓碑 → 可见性只由 `archivedFilter` 决定。

### 2.3 在同一实例上 1:1 复现

- 干净客户端、默认过滤器：`未分组` 分组**根本不存在**（`sessionVisible` 过滤掉）；
- 在**我自己的浏览器配置**里切到 `全部对话（显示已归档）`：立即出现 `未分组` + 上述两行，与用户截图完全一致（标题、右侧时长、归档暗色）。
- 用户自己的浏览器状态未被改动（视图过滤器持久化在浏览器本地：`persist: "dsh.workspace.view.v5"`）。

### 2.4 隔离环境复现（`%TEMP%\dsh-sm-e2e`，已停止实例）

在隔离 DSH_HOME 里用同一份插件删除一个刚打开过的会话：

1. 删除后 toast 为"已永久删除…残留的内存副本将在重启 dsh 后彻底清除"（即 `openAtDelete: true`）；
2. 默认视图下该行消失且不再出现；
3. 打开 `显示已归档` 后，该行出现在 `未分组`；
4. `session/list` 仍返回该 id，`deferred/list` 显示其 `recoverable: []`（文件已清）。

---

## 3. 为什么"更新 dsh 之后才出现"这个相关性不成立

把 `0.1.7-rc.2` 与 `0.2.0-rc.2`（用户更新前后的两个版本，按 npm 包逐字节对比）：

| 模块 | 差异 | 与本现象关系 |
|---|---|---|
| `dsh-api-session-controller` host `list()` | **完全相同**（同样不做归档过滤，live 会话照常返回） | 无 |
| `dsh-api-session-controller` client | 3 增 2 删（`hasIntrinsicConstructor` 判定、fork 的 `onCreated` 回调） | 无 |
| `dsh-client-ui-workspace`（`sessionVisible` / `groupByWorkspace` / `archivedFilter`） | 24 增 13 删（重命名快捷键改 `Ctrl+Alt+G`、fork 埋点、新增 `未命名` 文案） | 无：未分组 + 归档过滤器逻辑**逐行相同** |
| `dsh-session-query-sqlite` live 行 | **完全相同** | 无 |

即：**0.1.7 与 0.2.0 在本现象涉及的所有环节语义一致**。因此"更新后才出现"更可能是：

- 删除之后（或之前）把侧边栏切到了归档视图去核对 —— 于是正好看到这两个墓碑；或
- 更换/重置了浏览器本地视图状态，使归档行变为可见。

> 附注：0.2.0 新增了 `未命名`（`session.untitled`）文案，所以空标题会话在旧版会渲染成空文本、新版渲染为"未命名"——这也说明截图来自 0.2.0，但它只影响文案，不影响是否显示。

---

## 4. 影响边界

| 视图 / 时点 | 表现 |
|---|---|
| 默认（隐藏已归档） | 不可见（墓碑生效） |
| 全部对话（显示已归档）/ 仅显示已归档 | 可见，位于 `未分组`，带归档暗色样式 |
| 重启 dsh 后 | `sweepPending()` 收尾并清除墓碑，彻底消失 |
| 相关列表页 | 插件自身的 `list` / `deferred/list` 已把 pending 与墓碑过滤掉，不受影响 |

---

## 5. 修复选项（本次未改代码，供后续决策）

### 方案 A（审查后**否决**，勿直接落地）：删除时释放活会话

> 2026-09-29 复审结论：该方案会引入 4 类新问题（半关闭生命周期、`sessions.flush` 抛错、
> draining 判定挂起、disposal 写回产物），**已否决**。详见 §8。以下原文保留，作为被否决方案的记录。

删除"打开中"的会话时，通过 sessions 服务的公开入口把它从 store 中摘除：

```js
const live = tryGet('sessions')                 // ctx.get('sessions')
const session = live?.get(sessionId)            // 公开方法
const entry = live?.liveEntryFor?.(session)     // 公开方法：返回精确 live entry
entry?.detach?.()                               // enter() 公开返回的 detach 能力
```

预期效果链：

1. `ctx.sessions.list()` 不再包含它 → 查询层删除 live 行（`dsh-session-query-sqlite:657-689`）→ `session/list` 不再返回；
2. 摘除会触发 `session/disposed`，官方控制器随即自身广播 `api-session/removed`（`dsh-api-session-controller/lib/index.js:2876-2877`）；
3. 于是无需墓碑，**任何视图、任何客户端、刷新与重连都无法复活它**。

必须配套的风险控制（否则不要上）：

- 能力探测：`typeof live.liveEntryFor === 'function'`、`entry.detach` 为函数，全部 `try/catch`；任一步失败即回退到今天的墓碑流程；
- 仅对"非运行中"会话释放（现有 `session/running` 拒绝逻辑已经覆盖；`allowDeleteRunning: true` 时需评估：agent loop 仍在跑，之后 `sessions.flush(session)` 会因 `liveEntryFor` 抛 "not live in this store"）；
- detach 的能力所有者是 agent loop（`dsh-agent-loop` 的创建事务），提前释放会让 owner 的 teardown 变成 no-op（`enter()` 内部有 `entered` 幂等保护），但顺序语义与 `dsh-session/lib/index.js:1640-1668` 的注释约定相悖，需要在下一次 dsh 升级时重新验证；
- 若采用，需同步改写 `AGENTS.md` 中"dsh has no public close session API"的不变式描述，并补 host 测试（mock `sessions.liveEntryFor/get`，覆盖"能力缺失→回退墓碑"与"释放成功→不再写墓碑"两条路径）。

### 方案 B（安全缓解）：不再自己把残留拉回来 + 明示用户

- 客户端在 `api-session/removed` 之后的刷新（`lib/client.js:1053-1076`）对"本插件刚刚删掉的打开中会话"跳过，避免删除后立刻把残留灌回列表；
- 删除成功的 toast / README 中明确写出：若侧边栏处于归档视图，打开中的会话会以归档样式残留至下次重启（可在设置页用 `deferred/list` 查看）。

局限：刷新页面或重连仍会从主机重新取回，只是不再加剧；治标不治本。

### 方案 C（本次采用）：记录结论 + 建议上游

- 本文档即为结论；
- 建议向上游 dsh 提"session close/dispose"公开 API 的需求：只要存在一个受支持的关闭入口，本插件即可彻底移除残留，不再依赖归档过滤器与墓碑。

---

## 6. 后续复验方法（改任何代码后按此验证）

1. 隔离环境（切勿在真实 `~/.dsh` 上做破坏性验证）：
   - `node scripts/e2e-seed.mjs <e2e-home>`；
   - `DSH_HOME=<e2e-home> node <npm>/@deepseek-ai/dsh/lib/bin.js plugin --profile web add <repo>`；
   - `DSH_HOME=<e2e-home> node <npm>/@deepseek-ai/dsh/lib/bin.js web --port 3099`（用启动输出里的 token URL 打开）。
2. 在 UI 中打开一个非空会话（使其进入 live），再用菜单删除并确认；
3. 断言：
   - 默认视图无该行；
   - **切到"全部对话（显示已归档）"后也没有该行**（这才是方案 A 的验收点）；
   - `POST /api/session/list`（`payload.args._request = {}`）不再包含该 id；
   - `~/.dsh/storages/session-manager.pending.json` 与 `workspace.json` 中不残留该 id 的墓碑。

---

## 7. 诊断过程的副作用说明

- 为读取运行实例状态，用本机 `.credentials.yaml` 中的 `client-connection/browser-session` 签名密钥生成过一次**只读** cookie（仅本地 `127.0.0.1:3080`，未执行任何写操作）；
- 真实 home 的唯一变化：诊断用浏览器客户端首次加载时，dsh 自身在 `session_manager` 工作区创建了一个空白占位会话 `session-2e7e9143-251c-470e-89d5-3bbd8ddcc950`（`blank`、无消息，下次"新会话"会被 `reuseBlank` 复用），写入时间 21:12:32；
- 隔离复现 home 位于 `%TEMP%\dsh-sm-e2e`，3099 实例已停止，可直接删除。

---

## 8. 修复方案复审与最终实现（2026-09-29，v0.4.0）

### 8.1 为什么否决方案 A（`sessions.liveEntryFor(...).detach()`）

| # | 新问题 | 证据 |
|---|---|---|
| 1 | **半关闭生命周期**：会话从 `ctx.sessions` 摘除，但它所属的 agent 仍在 `ctx.agents` 里存活到进程结束；控制器只保留 `(await agents.resume(...)).agent`，带 `dispose()` 的 handle 被丢弃（`dsh-api-session-controller/lib/index.js:406-410、430-434、450-458`），第三方无从释放 agent | dsh 自身代码假设两者同生共死 |
| 2 | **`sessions.flush()` 必然抛错**：`flush()` 第一行即 `liveEntryFor(session)`（`dsh-session/lib/index.js:1832-1833、1851-1855`）。当前 web profile 已挂载的调用方包括 `goal-round-driver:109`、`session-checkpoint-policy:28/68/73`、`message-feedback:259`、`subagent:1273`、`agent-team:158/640/946`、`session-log-export:59` | 删除后的任何一次检查点/投递/续跑都会命中 |
| 3 | **draining 判定挂起**：`dsh-agent-loop:1630-1648` 的 `waitForDrainingConfiguredIdentity` 等待 `agents.get(id) === undefined && sessions.get(id) === undefined`；只摘 sessions 一侧会让配置驱动的同 id 启动永不满足条件 | 半关闭状态被 dsh 当成"仍在 draining" |
| 4 | **disposal 写回产物**：`session/disposed` 监听会立刻写盘——投影缓存 `flushSoft(session, "detach")` 无条件写 checkpoint（落点正是我们刚删的 `<id>.json`，`dsh-session-projection-cache/lib/index.js:316-320`），JSONL 持久化 `writer.close()` 做 final drain 且写入路径含 `mkdir(...recursive)`（`dsh-session-persistence-jsonl/lib/index.js:421-427、3123-3133`）；单次 sweep 不够，二次 sweep 又有竞态 | 残留/竞态无法消除，除非保留 pending 标记让下次启动再扫——那 A 就没有"根治"收益 |
| 5 | subagent 会话删除会打到父会话的 continuation flush | `dsh-subagent/lib/index.js:1273` |
| 6 | 需要把 `AGENTS.md` 的"无公开关闭 API"不变式改写成依赖未支持 seam——本仓库已被同类依赖咬过四次 | 见 AGENTS.md 中图标/slot/refresh seam/`/api` 拦截器的历史记录 |

### 8.2 最终实现：B（客户端）+ 可选 A′（宿主重播事件）

**B —— 客户端不再自我复活**（`lib/client.js`）

- 新增"待删残留"区块：`pendingDeleteIds` 集合由 `rpc` 包装器统一喂入
  （`deferred/list` 响应 → 并集；`delete` 且 `openAtDelete === true` → 加入；
  `deferred/cancel` 成功 → 移除）。放在 rpc 层是因为设置页/菜单项都是
  module-scope 组件，看不到 `apply` 闭包（否则运行时 `rememberPendingDelete is not defined`）。
- `scheduleRemovedRefresh(sessionId)`：排队 id 直接跳过；并记录本次去抖窗口的 id，
  **在触发时二次校验**——删除响应与事件走不同通道，事件常常先到（e2e 实测到了这个竞态）。
- 设置页批量删除：整批都是打开中会话时跳过整体回拉。
- 首次 ping 成功后读取一次删除队列（既做种子，也让开启了 A′ 的宿主重播事件）。

**A′ —— 宿主按需重播官方移除事件**（`lib/index.js`，配置 `reannouncePendingRemovals`）

- `deferred/list` 在配置开启时，对**仍存活**的排队 id 调 `announceRemoval(id)`；
  `announceRemoval` 收敛了原先散落两处的 `ctx.emit('api-session/removed', …)`。
- 判定按 `!== false` 读取（与 `menuDeleteAvailable` 同一约定），因此绕过 schema 的
  组合配置（测试里的裸 `{}`、旧调用方）也得到"默认开启"。
- 客户端侧按"一次残留一次修复"（`evaluateResidue`/`scheduleRepair`，300ms 去抖 +
  episode 标记）触发队列读取，**不会轮询**；残留清除后标记复位，下一次列表回拉可再修一次。
- **0.4.1 起默认 `true`**：0.4.0 发布后现场立即复现——用户侧边栏处于"显示已归档"，
  删除后仍能看到墓碑（见 §8.5 的现场证据），说明"默认关闭"让插件的承诺在默认配置下
  不成立。代价（事件与宿主列表相反、回拉后可能一帧闪现）有界且已写进 README，需要时
  可设 `false` 退回"仅墓碑"行为。

### 8.3 验证

- `pnpm test`：65/65（新增 3 条：宿主重播（含"配置关闭/存活判定失败时不重播"）、
  客户端"排队 id 不回拉 + 一次修复不轮询"、客户端"事件先于删除响应到达"的竞态回归）。
- 隔离实例 e2e（`scripts/e2e-residue.mjs`，真实 Chrome 驱动真实 UI）：
  - 配置关闭：菜单删除一个打开会话后，**默认视图与"全部对话（显示已归档）"都没有该行**（B 生效；
    修复竞态前同一脚本在归档视图会失败）；
  - 配置开启：加载时那个排队残留（`session-4f63d568…`）在归档视图**不再渲染**，
    再删一个打开会话后两个视图均为空。
- 真实实例未做任何破坏性验证。

### 8.4 仍然存在的边界（如实记录）

- 只做 B（或把修复钩子设为 `false`）时：**页面重载 / 另一个客户端**会从宿主列表重新
  学到该 id；默认视图仍隐藏它，归档视图会显示到下次重启（这就是修复钩子存在的理由）。
- 彻底根治仍需要上游提供"关闭会话"能力（见方案 C）；本仓库不改用未支持的 seam。

### 8.5 现场复核（0.4.0 发布后，真实实例只读观测）

用户报告"重启 dsh、插件显示 0.4.0，彻底删除后仍未分组里还有"。只读复核（`POST
/api/session/list`、`/api/session-manager/deferred/list`、读取 `storages/*.json`、
并在默认视图与 persisted `dsh.workspace.view.v5` 下观察 DOM）：

| 观测 | 值 |
|---|---|
| 插件版本（ping） | `0.4.0` |
| 待删队列 | `["session-69659dd4-…"]`，`recoverable: []`（文件已删） |
| 归档集（`workspace.json`） | 同 id（墓碑存在） |
| 宿主 `session/list` | 仍返回该 id，`agentAvailable: true`（内存副本存活） |
| 浏览器持久化的视图状态 | `"archivedFilter":"show"` ← 用户在"显示已归档"视图 |
| DOM | 该 id 以 `archived` 样式渲染在「未分组」 |

即：残留完全符合 §8.4 的描述，**不是新缺陷**；修复钩子当时是"默认关闭"，所以没有任何
东西去重播移除事件。因此 0.4.1 把 `reannouncePendingRemovals` 默认改为 `true`
（§8.2）。此前遗留的两个墓碑（`f4a72b82`、`a56c3963`）在本次重启的 boot sweep 中已被
正常清掉，说明启动收尾工作正常。
