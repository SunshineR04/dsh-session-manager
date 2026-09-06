# dsh-session-manager

DSH 插件：**已归档会话管理**。为 DeepSeek Harness 补齐官方 UI 缺失的能力 ——
官方工作区浏览器只有「归档会话」入口，归档之后会话从所有视图消失，没有查看、
恢复、彻底删除的界面。本插件补上这三件事，并在会话三点菜单里加一个红色的
「彻底删除」按钮。

## 功能

### 1. 设置页：设置 → 会话管理

- 列出全部**已归档会话**：标题、所属工作区、项目目录、更新时间、运行状态
- 每个会话提供 **恢复**（回到归档前在工作区中的位置）和红色 **彻底删除**
- 删除前弹出破坏性确认框——每次删除都是**直接物理删除**，没有备份层
- 数据来自官方的 session / workspace 客户端 store，**实时响应**，无需手动刷新

### 2. 会话三点菜单：红色的「彻底删除」

左侧会话列表中，鼠标悬停会话行 → 右侧 ⋯ 菜单，在原有 重命名 / 分叉会话 /
归档会话 下方新增红色「彻底删除」项，点击后同样弹出确认框。
会话通过 React fiber 树解析，与官方菜单视觉风格一致（危险红 + 危险 hover 底色）。

> 注：官方工作区浏览器没有为会话菜单提供任何扩展插槽，本插件通过 DOM 观测 +
> React fiber 定位来增强渲染出的菜单。该增强是**被动式**的：一旦宿主 UI 结构
> 变化导致定位失败，菜单按钮自动不出现，不影响其他任何功能。

### 3. 斜杠命令 `/sessions`

```
/sessions                          # 概览：归档数 + 用法
/sessions archived                 # 列出已归档会话（编号 + 标题 + 工作区 + 时间）
/sessions restore <#|id>           # 恢复（支持列表编号）
/sessions delete <id>              # 彻底删除（必须用完整 id，防编号漂移误删）
/sessions pending                  # 查看待删除队列（重启后自动彻底删除的会话）
/sessions pending cancel <id>      # 取消一个待删除项
```

> 斜杠命令走宿主的插件命令注册表，所有 base-backed 的 dsh 组合都已挂载（桌面端与 `dsh web` 均可）。安装或更新后输入 `/` 若没有命令菜单，重启一次应用即可：0.2.4 之前的版本在启动时序上注册过早。

### 4. Agent 工具（模型可直接调用）

| 工具 | 说明 |
| --- | --- |
| `session_list_archived` | 列出已归档会话（JSON） |
| `session_restore_archived` | 按 id 恢复（可逆操作，无需确认） |
| `session_delete_permanently` | 按 id 彻底删除；**必须 `confirm: true`**；拒绝删除正在运行的会话 |

## 安装

```bash
git clone https://github.com/SunshineR04/dsh-session-manager.git
dsh plugin --profile <name> add "file:<克隆目录的绝对路径>"
```

`dsh plugin add` 会通过 pnpm 安装并自动把包加入 `dsh.profile.bundles`；
本包的 `cordis.patch.yml`（bundle layer）自动挂载插件行，无需手改配置。
**安装后需重启 dsh 桌面端**（新 bundle 不会热加载）。

也可以在 profile 的 `cordis.patch.yml` 手工挂载（不推荐，bundle 通道更省事）：

```yaml
- insert:
    - id: session-manager
      name: dsh-session-manager
```

## 删除语义（重要）

「彻底删除」执行四件事，顺序经过设计：

1. **登记清理（先做，持久且广播）**：从所属工作区的 `sessionIds` 摘除
   （`detachSession`），再从全局归档集移除。摘除时并不只信任工作区
   `sessionIds` 的过滤视图——注册表的 canonical-cwd 头索引一旦失准，
   getter 会把该 id「隐身」，导致 detach 被跳过、已删会话以「未分组」
   身份复活（0.1.4 及之前的真实 bug），因此同时对照工作区的原始记录兜底。
2. **删除会话文件**：`~/.dsh/sessions/<编码项目目录>/<session-id>/`（
   `session.jsonl.zstd` 日志本体）。目录解析走三级兜底：注册表头 +
   persistence `locate` → persistence 头清单 → sessions 根目录原始扫描
   （目录名与已校验的会话 id 精确相等），头接缝失准不再会静默漏删。
3. **删除元数据缓存**：`~/.dsh/storages/session_projcache/sessions/<id>.json`
   及其 `.bak-*` 检查点。
4. **广播官方 `api-session/removed` 事件**：所有已连接客户端的会话列表
   立即移除该会话。（宿主自身只在 live 会话 dispose 时才发这个事件，
   冷删除永远等不到。）

搜索索引（SQLite）会随源文件消失自动对账，无需处理；附件存储是内容寻址的，
保留不误伤其它会话，也不做删除。

- 每次删除都是**直接物理删除**——没有备份层，确认框请看清会话标题。
- **删除已打开的会话同样立即生效**：登记、文件、元数据当场清除（后续
  flush 不会复活任何东西——append 按路径打开日志，从不重建已删目录）。
  由于 dsh 没有公开的「关闭会话」API，内存中的副本会存续到所属界面作用域
  消失为止；此时该 id 以**墓碑**形式保留在归档集中——工作区浏览器与所有
  列表都会继续隐藏它，重启 dsh 后自动完成收尾清理。运行中的会话仍然拒绝。
- **待清理横幅**：设置页顶部列出已标记删除的会话。文件已删的条目（打开
  会话的正常删除）只显示「已删除 · 重启后自动清理」，没有取消按钮；只有
  文件仍在盘上的条目（例如删除中途崩溃的残留）才提供「取消删除」，取消时
  会连墓碑一起清掉。
- **恢复操作**只从归档集移除 id —— 归档本身保留工作区 `sessionIds` 槽位，
  因此恢复后会话回到**归档前的原位置**。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sessionListLimit` | `500` | 单次列表返回上限 |
| `allowDeleteRunning` | `false` | 允许删除 live 会话（危险） |
| `toolDeleteRequiresConfirm` | `true` | Agent 删除工具强制 `confirm: true` |
| `menuDeleteAvailable` | `true` | 是否在三点菜单挂红色删除项 |

## 开发

```bash
pnpm install
pnpm test   # 语法检查 + 宿主单测 + 客户端渲染冒烟测试
```

渲染测试（`test/client.render.test.mjs`）用 React + jsdom 真实挂载设置页
组件，能抓住宿主单测覆盖不到的 UI 崩溃（如 hooks 顺序 / 变量提升错误）。

接入验证：新建临时 profile 挂载本插件后

```bash
dsh --profile <test-profile> --dump-config    # 检查 bundle 组装
dsh --profile <test-profile> --help           # 完整启动（headless 模板）
```

浏览器端到端验证（隔离 DSH_HOME，不碰真实数据；需要本机 Chrome 与 puppeteer-core）：

```bash
cp scripts/e2e-seed.local.example.json scripts/e2e-seed.local.json
#    ^ 填入你自己的会话/工作区数据（已 gitignore，不会提交）
node scripts/e2e-seed.mjs <e2e-home> ~/.dsh          # 1. 播种隔离测试 HOME
# 2. 在该 HOME 下建 profile 装本插件，再启动测试 web 实例：
#    DSH_HOME=<e2e-home> dsh --profile sm-test --port 43123 --no-open
node scripts/e2e-check.mjs <打印出的带 token 的 URL>  # 3. 只读检查：三点菜单/设置页
node scripts/e2e-mutations.mjs <URL> <e2e-home>       # 4. 闭环：恢复→归档→彻底删除
```

## 参考项目

本插件在开发前调研了以下 GitHub 项目（其中部分可直接在本地
`~/.dsh/profiles/desktop/node_modules` 中对照源码）：

- [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) ——
  dsh 社区插件标杆：bundle patch、client 注入、settings.section 注册、
  `/sidebar/api` 宿主路由，都是本插件结构的直接参照。
- [ysr666/dsh-vision-router](https://github.com/ysr666/dsh-vision-router) ——
  同类「设置页 + 宿主 RPC + 手写无打包 client」插件，client 模块骨架完全照此。
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) ——
  dsh 本体：`dsh-api-workspace-controller`（archiveSession / follow 流）、
  `dsh-api-session-controller`、`dsh-session-persistence-jsonl`（目录编码、
  zstd 日志）、`dsh-workspace`（归档集语义与恢复定位）等包是本文档所有行为
  结论的依据。
- [koishijs/koishi](https://github.com/koishijs/koishi) —— dsh 的 Cordis 插件
  运行时上游，`ctx.effect` / `ctx.inject` / patch 体系的理解来源。
- [tmux-plugins/tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) ——
  概念参照：终端会话的保存/恢复/清理产品形态。
- [opencode-ai/opencode](https://github.com/opencode-ai/opencode) —— 概念参照：
  编码代理的会话持久化与恢复入口设计。

## License

MIT
