# AutoClaw 国内版：网页登录链接改由 CLI 脚本输出（替代被 GUI 截断的窗口行）

- 日期：2026-11-26
- 仓库：`magpie-plugins`，包 `packages/autoclaw-cn-auth`（0.4.0 → 0.5.0）
- 状态：待实现

## 1. 问题

0.2.0 起 `usage()` 把网页登录链接放进窗口 `display`：`https://autoglm.zhipuai.cn/?autoglm_token=<access>`（约 640 字符）。在 magpie GUI（0.1.4823）里**显示不全且无法复制**。

根因在宿主渲染，不在插件：

| 现象 | 原因 | 位置（yetone/magpie main） |
|---|---|---|
| 显示不全 | `display` 原样进 `.qt-fig`，`white-space: nowrap` + 表格列宽固定 | `internal/gui/assets/app.css:1123` |
| 无法复制 | 表格单元格不在 `user-select: text` 白名单；文本行只有悬浮 `title`，无点击/复制动作 | `app.css:174`、`quotatable.js:81-98` |
| 无契约可用 | `usage.windows` 白名单无 url/link 字段 | `internal/plugin/host.js` usage 段 |

即该链接在 Usage 表格里天生没有可用出口。

## 2. 方案

### 2.1 窗口行改为短提示

`网页版快捷登录` 窗口保留（位置不变），`display` 改为固定短文案：`打开网页版：bunx magpie-autoclaw-cn-auth web`。不再携带 token，GUI 可完整显示。

### 2.2 新增 CLI 脚本 `web.mjs`（包根，随 `files` 发布）

用法：

```
bun web.mjs [--account <key>] [--print] [--no-open] [--base <url>]
# 发布后：bunx magpie-autoclaw-cn-auth web [--account autoclaw#9q9l5x] [--print]
```

| 参数 | 作用 |
|---|---|
| `--account <key>` | `plugin-auth.json` 的键，默认 `autoclaw` |
| `--print` | 只打印链接，不打开浏览器 |
| `--no-open` | 同 `--print` 的别名（语义更直白） |
| `--base <url>` | 覆盖网页站点（等价 `AUTOCLAW_WEB_BASE_URL`，便于测试） |

流程：

1. 定位凭据文件：`AUTOCLAW_AUTH_FILE`（显式覆盖）→ `AUTOCLAW_CONFIG_DIR` → `$XDG_CONFIG_HOME/magpie` → `$HOME/.config/magpie` → `%USERPROFILE%\.config\magpie` → `os.homedir()`。Windows 上绝不落盘根。
2. 读取该账号记录；`type !== "oauth"` 或无 `access` → 报错退出码 2。
3. 若 `expires - now < REFRESH_LEAD`（5 分钟）且有 `refresh`：调 `renewTokens` 续期，然后**带锁写回**（见 2.3）；无 `refresh` 则直接用现有 access 并提示剩余有效期。
4. 输出：
   ```
   账号：185****9906（autoclaw）
   链接：https://autoglm.zhipuai.cn/?autoglm_token=eyJ…
   有效至：2026-11-26 11:52（北京时间）   ← 链接随 access 过期失效
   ```
5. 默认打开浏览器：`start <url>`（win32）/ `open`（darwin）/ `xdg-open`（linux）；spawn 失败退回只打印。`--print` 时跳过。

### 2.3 写回必须遵守宿主的锁协议

宿主（`host.js` `changeAuth`/`lockAuth`/`writeAuth`）对 `plugin-auth.json` 的约定：

- 互斥：`plugin-auth.json.lock`，`openSync(lock, "wx", 0o600)` 成功即持有；`EEXIST` 时等 5–50ms 退避重试；锁文件 mtime 超过 **10 秒**视为残留可删；总等待上限 **20 秒**。
- 改动：**加锁后重新读取**文件，只改目标键，其他键保持读到的最新值（防止覆盖宿主刚写入的别家 token）。
- 写入：原子写（临时文件 → rename），内容 `JSON.stringify(all, null, 2) + "\n"`。
- 宿主通过 mtime/size/ino + 字节比较感知外部修改（`noteAuth` → `forgetAccount`），**无需重启**即可让宿主丢掉旧 loader。

脚本实现同一套：`withAuthLock(fn)`，`fn` 内「重读 → 改一键 → 原子写」。写回失败时**仍输出链接**（当前 access 仍有效），但明确警告：「续期成功但写回失败，magpie 中的 refresh 已失效，请重新登录」。

### 2.4 依赖与复用

- `web.mjs` 从 `./index.mjs` 导入 `_internal.renewTokens`、`webEntryUrl`、`REFRESH_LEAD`、`jwtEnd`、`ID`；不重复实现签名/续期协议。
- 运行时依赖：Node ≥ 18 或 Bun（只用 `node:fs`/`node:os`/`node:path`/`node:child_process`，`fetch` 为全局）。
- `package.json`：`files` 加 `web.mjs`；`bin` 字段加 `"magpie-autoclaw-cn-auth": "./web.mjs"`（带 shebang `#!/usr/bin/env node`）；新增 `exports: { ".": "./index.mjs", "./web": "./web.mjs" }` 不加——保持现有单一入口，避免影响 magpie 加载。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `index.mjs` | `WEB_ENTRY_WINDOW` 的 `display` 改短提示；`_internal` 导出 `webEntryHintText`（供测试） |
| `web.mjs`（新） | 上述 CLI：参数解析、凭据定位、续期、带锁写回、输出、打开浏览器 |
| `web.test.mjs`（新） | 见 §4 |
| `index.test.mjs` | 更新网页窗口断言（短文案、不含 token） |
| `README.md` | 用法、参数、锁语义、安全提示；删掉"GUI 里复制链接"的旧说法 |
| `package.json` | 0.4.0 → 0.5.0；`files` + `bin` |

## 4. 测试用例（全部打临时目录 + fake，零外网、不碰真实 `~/.config/magpie`）

1. token 充足（>5 分钟）：不调续期，`--print` 输出的链接 = `webEntryUrl(access)`，含编码后的 access；退出码 0；不写文件（mtime 不变）。
2. token 临期：调用续期（fake 记录 `refreshCalls=1`），输出新 token 的链接；`plugin-auth.json` 中该键的 `access/refresh/expires` 已更新。
3. 带锁写回：预置一个**其他键**（模拟别家账号）在文件里，续期写回后该键原样保留；写回期间锁文件存在（脚本内断言或测试用钩子）。
4. 并发保护：预置一个 mtime 1 秒内的 `.lock`（他人持有）→ 脚本等待后成功（用 fake 延迟释放）；预置 mtime 11 秒的残留锁 → 直接清掉继续。
5. 写回失败（目录只读/路径指向目录）：仍打印链接，stderr 含「写回失败」警告，退出码 0。
6. 无 refresh 且临期：不续期，打印链接并提示「剩余 N 分钟，链接即将失效」。
7. 未登录（`type !== "oauth"` 或缺 access）：退出码 2，stderr 说明「未登录」。
8. `--account` 指定第二账号：使用对应键的凭据；键不存在 → 退出码 2。
9. `--print`/`--no-open` 不调用 `child_process.spawn`；默认模式在测试里通过注入的 opener 断言收到正确 URL（不真开浏览器）。
10. 窗口行：`usage()` 的网页窗口 `display` 等于短提示、不含 `autoglm_token`；其余窗口顺序与字段不变。
11. 既有 74 条全绿。

## 5. 验收标准

- `bun test` 全绿（≥ 84 用例）；`web.test.mjs` 的凭据文件、锁文件全部在 `mkdtemp` 目录内，通过 `AUTOCLAW_AUTH_FILE` 指向。
- `node web.mjs --print` 与 `bun web.mjs --print` 在 Node 18+/Bun 下都能跑（CI 至少覆盖 Bun）。
- 写回严格遵循锁协议（wx 创建、10s 残留阈值、20s 上限、加锁后重读、原子写、2 空格缩进 + 末尾换行）。
- README 与实现一致；窗口 `display` 不再含 token。

## 6. 风险

- 宿主若未来改锁协议（文件名/阈值），脚本写回可能与宿主竞争；缓解：写回只改单键、加锁后重读，最坏情况是丢一次续期而非覆盖他家 token。
- 链接含实时凭证：脚本输出即敏感，README 明示不要贴到聊天/文档；`--print` 输出到 stdout 便于管道但同样敏感。
- `bin` 入口在 Windows 上由 npm 生成 `.cmd`，需用户用 `bunx`/`npx` 调用；README 给出两种命令。
