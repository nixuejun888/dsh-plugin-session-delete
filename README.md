# dsh-plugin-session-delete

[![test](https://github.com/nixuejun888/dsh-plugin-session-delete/actions/workflows/test.yml/badge.svg)](https://github.com/nixuejun888/dsh-plugin-session-delete/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 DSH 加一个「删除对话」能力：会话行的 `...` 菜单里多一项**删除对话**，确认后真正把该对话从磁盘上移除。

> **English** — A **Delete conversation** action for [DSH](https://github.com/deepseek-ai) (DeepSeek Harness). DSH ships no session-deletion API (`dsh-session-persistence` is append-only; `@deepseek-ai/dsh-workspace` can only *archive*), so this plugin deletes **out-of-band**: it archives the session first — that is what makes the sidebar row disappear immediately — then moves the session log and its projection cache into a recoverable trash directory, or permanently removes them when the「永久删除」box is ticked. Install by cloning this repository and linking it into your DSH profile (see 安装 below); it is not published to npm. MIT licensed. Both halves load only at DSH startup, so a **full restart** is required after installing or editing it.

## 为什么需要它

DSH 本身没有删除会话的 API：

- `dsh-session-persistence` 是只追加的（`create/open/stat/list/flush`），README 明确写着 *"No deletion or retention API"*；
- `@deepseek-ai/dsh-workspace` 的 `archiveSession` 只是**隐藏**（归档）会话，README 明确写着 *"session deletion or folder removal are separate, absent capabilities"*。

所以删除只能做**带外维护**，直接操作持久层拥有的存储布局：

```
<DSH_HOME>/sessions/<项目slug>/<sessionId>/session.v4.jsonl.zstd   ← 会话日志
<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json    ← 投影缓存
```

## 安装（本地挂载，未发布 npm）

包名是 `@local/dsh-plugin-session-delete`：`@local/` 作用域表示这是本地插件，**没有发布到 npm**（`private: true` 就是防止误发）。安装方式是克隆本仓库后 `link:` 进 DSH profile。下面用 `<REPO>` 表示克隆目录、`<DSH_HOME>` 表示 DSH 主目录（默认 `~/.dsh`）、`<profile>` 表示 profile 名（如 `desktop`）：

1. `<DSH_HOME>/profiles/<profile>/package.json` 的 `dependencies` 里加
   `"@local/dsh-plugin-session-delete": "link:<REPO>"`；
2. 在 `<DSH_HOME>/profiles/<profile>/node_modules/@local/` 下建一个指向 `<REPO>` 的链接：
   - Windows：`New-Item -ItemType Junction -Path <...>\node_modules\@local\dsh-plugin-session-delete -Target <REPO>`
   - macOS / Linux：`ln -s <REPO> <...>/node_modules/@local/dsh-plugin-session-delete`
3. `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 末尾加
   ```yaml
   - insert:
       - id: session-delete
         name: '@local/dsh-plugin-session-delete'
   ```
4. **完全重启 DSH**（两半都只在启动时加载，见下文「生命周期」）。

卸载：删掉上面三处，重启 DSH。回收站里的会话目录可以手动移回 `sessions/<项目slug>/`。

## 仓库结构

```
lib/index.js          Host 半边：HTTP API + Agent 工具 + 带外删除
lib/client.js         Client 半边：手写的 window.__ModuleLoader__ bundle（无构建步骤）
test/host.test.mjs    Host 单元测试（假 DSH_HOME，安全）
test/client.test.mjs  Client bundle 冒烟测试（stub 出 React/window/document）
test/e2e-real.mjs     真实存储上的可逆端到端（默认不跑，见下）
cordis.patch.yml      供 profile bundle 方式挂载
```

## Host 半边（`lib/index.js`）

- `inject = ['tools', 'webServer', 'connection']`。
- HTTP API 前缀 `/dsh-session-delete-api`（走 `ctx.connection.admit(req)` 鉴权；**取不到鉴权服务时直接 503 拒绝**，不降级放行）：
  - `GET /status` → 存储根目录、回收站目录、磁盘上会话数量；
  - `GET /sessions` → 磁盘上所有会话（id / 项目 / 路径 / 大小 / 修改时间）；
  - `POST /delete` `{ sessionId, mode }` → 删除。
- 工具 `dsh_delete_conversation`（`{ sessionId, mode? }`），让 Agent 也能删。
- **安全护栏**：非法 id、当前正在进行的会话、**仍在运行**的会话一律拒绝。判定「仍在运行」用的是 DSH 自己的准入缝隙 `ctx.waterfall('workspace/session-activity', { sessionId }, () => [])` —— 与 `dsh-workspace` 归档会话时同一个 waterfall（由 Agent registry / job registry / Subagent runtime / Schedule 提供者回答）；没有 waterfall 的运行时降级为查 `ctx.agents`。**不要**用 `sessions.list()` / `sessionQuery.listSessions()` 判断 live：它们返回的是所有*已持久化*的会话，会把每个对话都判成 live（这正是 0.1.0 版「任何对话都删不掉」的原因）。
- **默认 mode = `trash`**：把会话目录 `rename` 到 `<DSH_HOME>/plugins/dsh-session-delete/trash/<id>--<时间戳>`，可人工恢复；`mode: 'purge'` 才是 `rm -rf`。默认值取自插件配置的 `defaultMode`。审计记录写在 `<DSH_HOME>/plugins/dsh-session-delete/deleted.jsonl`：成功、失败、部分失败都追加一条（失败条目带 `ok:false`、`restored`、`destroyed`、`stranded`）。
  - 回收站**没有自动清理策略**，会一直占用磁盘（也会被 `DSH_HOME` 的备份一并带走）。需要回收空间时自行清空该目录，或用界面上的「永久删除」。
  - 同一个 id 若在多个项目 slug 下都留有目录，会**全部**移除（每个副本一个 trash 条目，名字追加 `-1`、`-2`…），避免删一半、留一半。
  - `projectionRemoved` 表示「投影缓存原本存在且已删除」，不存在时为 `false`（`rm(..., {force:true})` 对不存在的文件也会成功，所以先 `stat` 再断言）。
  - 失败回滚是**有损的**：purge 已经删掉的目录无法恢复，只能如实报告 `destroyed`（已永久删除的目录）与 `stranded`（还原失败、滞留在回收站的副本）。**只有确实什么都没丢**（`destroyed` 与 `stranded` 都为空）时才把行放回侧边栏；否则保持归档、报 `io-error`，因为放回去只会留下一个打不开的行。
- **先归档再动文件**：删除前调用 `workspaceRegistry.archiveSession(id)`（必须在文件还在时调用，注册表拒绝未知 id）。归档是「让这一行当场消失」的唯一受支持手段，见下一节。
  - 注册表**不存在**（`archiveSession` 不是函数）、或它**不认识这个会话**（`WorkspaceUnknownSessionError`）时，照常删除：前一种运行时根本没有归档集可用，后一种说明侧边栏也没有它的行。
  - 注册表**拒绝**归档时，先看拒绝原因是不是「有活动」：是（`WorkspaceActiveSessionError` 自带活动清单，或紧接着重查 waterfall 仍有活动）就报 `reason: 'active'` 并拒绝删除；**其它原因的拒绝不否决删除**，只把 `archiveError` 一起返回、`archived: false`，message 里说明「侧边栏可能仍显示这个对话：重启 DSH 后会消失」。理由：归档准入会调用**全库**的 `sessionPersistence.list()`，任何一条日志损坏都会让*每个* id 都抛错；让装饰性的一行否决删除，就等于复现「任何对话都删不掉」。
  - 回滚只撤销**本次调用自己建立**的归档（先读 `registry.archivedSessionIds`；读不到时视为「不确定」，该次归档不参与回滚），不会把别处预先存在的归档状态抹掉。
- **并发**：同一个 sessionId 的删除用 in-flight 集合串行化，第二个调用者得到 `reason: 'busy'`，不会和第一个抢同一批文件。
- **拒绝原因**：`invalid-id`、`invalid-mode`、`current-session`、`busy`、`not-found`、`active`（有活动在跑）、`io-error`。其中 `current-session` 在任何磁盘查找**之前**用 `DSH_SESSION_ID` 判定（否则当前会话目录已不在时报的是 `not-found`）。注意它的范围是**本进程自己正在进行的那个会话**；「已经打开但空闲」的对话是**故意允许删除**的 —— 用户要删的正是它。
- 不修改 `workspace.json`：会话成员关系是「读时过滤」，宿主下次写入时会自行剪枝；归档集就是在这里落盘。
- **生命周期**：注册走 `ctx.effect(() => registerSurfaces(...), label)`。Cordis 会忽略插件 `apply` 的返回值，所以「`return` 一个清理函数」等于从不清理 —— 卸载后会留下一个活着的工具和一条 `500 inactive context` 的僵尸路由，直到重启。
- **改完 host 半边必须重启 DSH**：DSH 不会热重载插件模块，仅改 `cordis.patch.yml` 也无法让新代码生效（而且拿掉 insert 条目再放回去会把该 fiber 置于半加载状态）。

## Client 半边（`lib/client.js`）

手写的 `window.__ModuleLoader__.load({ id, factory })` bundle（无构建步骤，只用 shell 预置的 `require('react')`）：

- 往 `sidebar.workspaces.session.menu.item` 注册 `id: 'session-delete'`（`order: 500`），props 为 `{ sessionId, displayTitle }`；
- 往 `shell.overlay` 注册确认对话框与结果提示；对话框里可勾选**永久删除**（不进回收站），勾选后请求带 `mode: 'purge'`，按钮变成红色的「永久删除」；
- 确认后的顺序是**先藏行、再删文件**：先用客户端 `workspaces.archiveSession(sessionId)` 把这一行收起来，再 `POST /delete`；宿主拒绝或请求失败时用 `unarchiveSession` 把行放回去。归档必须排在请求之前 —— 注册表只接受「仍然存在」的会话，等宿主应答时日志已经不在磁盘上了。对当前版本的 Host 这一步是 no-op（Host 已经归档过），它的价值在于 Host 还是旧代码、或宿主归档被拒时仍能让这一行离开侧边栏；
- 成功后若 900ms 时侧边栏仍在渲染 `[data-row-key="session:<id>"]` / `[data-session-id="<id>"]`，只把「侧边栏还在显示它：重启 DSH 后这一行会消失」追加进提示里 —— **绝不**自动 `location.reload()`：行还在是因为该会话常驻在 host 内存里，刷新页面会向同一个宿主重新取到同一份列表，既无效，又会丢掉用户正在输入的草稿；
- 对话框用的是应用主题令牌（`--dsw-alias-bg-overlay` / `--dsw-alias-label-primary` / `--dsw-alias-border-l1` / `--dsw-alias-state-error-primary`），不是硬编码深色；结果提示是整屏**点击穿透**的遮罩，不会吃掉屏幕中央的点击；
- **已知边缘情况**：若侧边栏的归档筛选被切到「显示已归档」，归档会**照常保留这一行**（`sessionVisible` 的 `case "show": return true`），任何提示也去不掉它。把筛选切回默认档即可。
- **Client 半边同样要重启 DSH**：client bundle 在 DSH 启动构图时被 `readFileSync` 读入并按 `immutable` 缓存，刷新页面不会重新取包。

## 测试

三个可重复运行的套件，都在 `test/`，用 Node 22+ 执行，**不需要安装任何依赖**：

```bash
npm test          # host + client 两套，安全：host 测试只用临时目录
npm run test:e2e  # 真实存储上的可逆端到端（默认拒绝运行，见下）
```

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `test/host.test.mjs` | Host 半边：全部拒绝原因、trash/purge、多 slug、并发 busy、归档四态（含「非活动拒绝仍删」）、部分失败与回滚（`withLocked` 制造确定性存储失败：Windows 用「进程 CWD 不可删/不可改名」，POSIX 用「父目录只读」）、投影缓存语义、审计流水、HTTP 状态码（200/400/401/404/503/500） | 88 passed / 0 failed |
| `test/client.test.mjs` | Client 半边：bundle 契约、槽位注册、确认对话框渲染与主题令牌、请求形状与重入保护、先藏行后删文件（含顺序证明）、拒绝时回滚、提示文案、绝不 reload | 51 passed / 0 failed |
| `test/e2e-real.mjs` | **真实存储**上的可逆端到端：挑一个无归属会话，删前做全树 sha256 快照，走真实 `POST /delete`，验证归档发生在文件仍在时、trash 副本逐字节一致、投影缓存与审计流水，最后 `finally` 原样搬回并校验字节一致 | ALL PASSED |

⚠️ `test/e2e-real.mjs` 直接操作**真实**的 `DSH_HOME`，因此默认打印说明后退出，必须显式开启：

```bash
DSH_SESSION_DELETE_E2E=1 DSH_HOME=~/.dsh node test/e2e-real.mjs
```

它虽然**始终还原**（会话目录与投影缓存逐字节还原、归档集回滚），但仍会往真实的 `deleted.jsonl` 追加一条记录、并在回收站留下一个空条目 —— 这两处按设计不清理。它内部的 `workspaceRegistry` 是**内存 stub**（独立归档集，没有 `sessionKnown`/`requireState`/waterfall），所以它证明的是插件的顺序与字节级行为，不是真实注册表的契约。

## 为什么「删除」必须顺带归档，否则要重启才刷新

`sessionQuery.listSessions()`（`@deepseek-ai/dsh-session-query` 的 `listSessions`）先读持久层，**再把常驻内存的会话叠加回去**：

```js
const records = await listPersisted(persistence, signal)      // 磁盘上的会话
for (const session of this._ctx.sessions.list()) {            // 已打开、常驻 host 内存的会话
  records.set(session.id, { header: …, live: true, persisted: … })
}
```

而 `ctx.sessions` 只有 `create/prepare/enter/announce/flush/get/list/fork`，**没有任何移除条目的方法**，`sessionController` 也没有删除/驱逐接口。所以：一个**已经打开过**的对话，即使它的文件已经被删掉，在 DSH 重启（丢掉常驻内存）之前仍会被列出来。

侧边栏渲染时会按归档集过滤（`dsh-client-ui-workspace/lib/client.js:357-367` 的 `sessionVisible`，默认档 `!archived.has(id)`），所以归档是让这一行当场消失的**唯一受支持手段**。`archiveSession` 对「没有归属任何工作区」的会话同样有效（`dsh-workspace/lib/index.js:507-540`：*"The session must exist (live or in session persistence); its workspace accounting — or lack of one — is irrelevant."*），并且会顺手取消 pin。

## 卸载

删掉 `cordis.patch.yml` 里的 insert 段与 `package.json` 里的依赖，重启 DSH。回收站里的会话目录可以手动移回 `sessions/<项目slug>/`。
