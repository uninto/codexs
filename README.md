# codexs

`codexs` 是一个轻量的 Codex 账号切换 CLI。

它把账号统一存放在 `~/.codex-accounts/`，每个目录只保存
`auth.json`：

```text
~/.codex-accounts/
├── user-a@example.com/
│   └── auth.json
└── user-b@example.com/
    └── auth.json
```

CLI 不会打印 token。它优先从 `auth.json` 的 `id_token` payload 中解析
`email`；如果没有邮箱，再回退到 `tokens.account_id` 的前 8 位，
用于列表显示和账号目录命名。

## 运行方式

临时运行：

```bash
npx @uninto/codexs help
npx @uninto/codexs list
```

全局安装后运行：

```bash
npm install -g @uninto/codexs
codexs help
```

本地 clone 后运行：

```bash
node ./bin/codexs help
./bin/codexs help
```

## 多端范围

Node CLI 支持以下终端环境：

- macOS
- Linux
- WSL
- Windows Git Bash
- Windows cmd
- Windows PowerShell

运行要求：

- Node.js 18+
- 已安装或可定位 `codex`

## 用法

初始化本机已有 Codex 登录态：

```bash
codexs init
# 或
codexs i
```

`init` 会先检查基础环境：

- `codex` 可执行文件可找到
- `~/.codex/auth.json` 存在、可读、不是符号链接
- `~/.codex-accounts/` 可创建、可写、不是符号链接

检查通过后，CLI 会从当前 `~/.codex/auth.json` 解析邮箱；如果没有邮箱，
则改用 `account_id` 前 8 位，并同步为账号目录。目标账号已存在时，
`init` 不会覆盖已有目录：

```bash
~/.codex-accounts/<email-or-short-id>/auth.json
```

登录账号：

```bash
codexs add
```

`add` 会调用 `codex login` 完成登录，并按登录态里的邮箱，或邮箱缺失时
的 `account_id` 前 8 位落到：

```bash
~/.codex-accounts/<email-or-short-id>/auth.json
```

如果该邮箱已存在，`add` 会直接覆盖已有账号目录里的 `auth.json`，
不会额外保留一份新登录结果，也不会残留 `.login.*` 临时目录。

查看账号列表：

```bash
codexs list
# 或
codexs l
```

`list` 默认会先联网查询额度信息，但不走模型生成：

- 优先显示套餐、5 小时额度、周额度
- 账号列直接显示完整邮箱；邮箱缺失时显示短 ID，不做截断
- 账号显示顺序与 `codexs use N`、`codexs remove N` 的编号解析顺序一致
- 当前账号会在编号后显示绿色 `*`，行颜色仍按账号状态显示
- 额度检测失败的账号，会直接用 Usage 接口探活
- limited 账号显示为浅黄色，cooling 账号显示为浅灰色
- 明确 401 / 403 的 offline 账号会显示为浅红色
- 网络异常等未知状态只标为未知

本地状态检查时：

- `已登录`：账号目录里有 `auth.json`
- `未登录`：账号目录存在，但没有 `auth.json`
- `离线`：Usage 接口探活明确返回 401 / 403
- `未知`：网络异常、服务异常或其他无法确认的探活失败

切换账号：

```bash
codexs use
# 或
codexs u

codexs use 2
# 或
codexs u 2

codexs use 6b17e1c8
```

`use` 不带账号时会先查询额度：

- 当前生效账号处于 available 时，不自动切换
- 当前生效账号处于 limited、cooling 或 offline 时，才会尝试自动切换
- 触发自动切换后，会切到第一个 available 账号
- 如果列表里没有 available 账号，也不会强制切换
- 如果额度接口不可用，或当前没有 available 账号，则报错或保持不切换

额度判定规则：

- 付费账号比较 5 小时剩余额度；只要周额度为 0，就视为冷却账号，不参与自动切换
- 免费账号没有 5 小时额度，只比较周剩余额度
- 自动切换不比较当前账号和目标账号的具体百分比

`use` 带账号时会把目标账号的 `auth.json` 覆盖到：

```bash
~/.codex/auth.json
```

删除账号：

```bash
codexs remove 2
# 或
codexs r 2
```

`remove` 会删除账号库里的目标账号目录，并同步清理所有 `.login.*`
临时登录目录；不会修改当前生效账号：

```bash
~/.codex/auth.json
```

删除离线账号：

```bash
codexs remove
# 或
codexs r
```

无参 `remove` 会通过 Usage 接口探活所有已登录账号，并只提示是否删除
明确离线（401 / 403）的账号；网络异常、服务异常等未知状态会跳过。
没有 `auth.json` 的账号目录也会提示删除。确认选项：

```text
1：确定
2：取消
```

## 环境变量

```bash
CODEX_ACCOUNTS_ROOT=$HOME/.codex-accounts
```

用于覆盖账号根目录。

```bash
CODEX_BIN=/path/to/codex
```

用于指定 `codex` 可执行文件路径。

如果没有设置 `CODEX_BIN`，CLI 会按顺序查找：

1. 当前 `PATH` 里的 `codex`
2. VS Code 扩展目录里的 `~/.vscode/extensions/openai.chatgpt-*/bin/*/codex`

```bash
NO_COLOR=1
```

用于关闭终端颜色输出。
