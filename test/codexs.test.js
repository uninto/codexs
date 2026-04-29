const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const commands = require('../src/commands');
const usage = require('../src/usage');
const { normalizeAccount, readAccounts, validateName, writeAccounts } = require('../src/accounts');
const { getUsageRowColor } = commands;
const { ACCOUNT_USAGE_STATES } = usage;

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'codexs');

// 为每个用例创建隔离 HOME，避免污染真实 Codex 配置。
const makeTempHome = () => {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codexs-test-'));
};

// 生成测试用的无签名 JWT，只用于让解析逻辑读取 payload。
const makeJwt = (email) => {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payloadValue = typeof email === 'string' ? { email } : email;
  const payload = Buffer.from(JSON.stringify(payloadValue)).toString('base64url');
  return `${header}.${payload}.signature`;
};

const writeAuth = (homeDir, email, extraTokens = {}) => {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const auth = {
    tokens: {
      id_token: makeJwt(email),
      ...extraTokens,
    },
  };
  fs.writeFileSync(
    path.join(homeDir, 'auth.json'),
    JSON.stringify(auth),
    { mode: 0o600 },
  );
  syncTestStoreFromLegacyDir(homeDir, auth);
};

const syncTestStoreFromLegacyDir = (homeDir, auth) => {
  const parts = homeDir.split(path.sep);
  const index = parts.lastIndexOf('.codex-accounts');
  if (index < 1) return;
  if (parts[index + 1] && parts[index + 1].startsWith('.')) return;
  const home = parts.slice(0, index).join(path.sep) || path.sep;
  const env = { HOME: home };
  const existing = readAccounts(env).filter((account) => account.id !== normalizeAccount(auth).id);
  writeAccounts([...existing, normalizeAccount(auth)], env);
};

const writeLegacyAuth = (homeDir, email, extraTokens = {}) => {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(homeDir, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: makeJwt(email),
        ...extraTokens,
      },
    }),
    { mode: 0o600 },
  );
};

const writeUsageAuth = (homeDir, email) => {
  writeAuth(homeDir, email, {
    access_token: `access-token-${email}`,
    account_id: `account-${email}`,
  });
};

const writeAuthWithIdentity = (homeDir, identityPayload, extraTokens = {}) => {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const auth = {
    tokens: {
      id_token: makeJwt(identityPayload),
      ...extraTokens,
    },
  };
  fs.writeFileSync(path.join(homeDir, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  syncTestStoreFromLegacyDir(homeDir, auth);
};

const readAccountsFile = (home) => {
  return JSON.parse(fs.readFileSync(path.join(home, '.codex', 'codex-accounts.json'), 'utf8'));
};

const writeFakeCodex = (binDir) => {
  const binPath = path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    fs.writeFileSync(binPath, '@echo off\r\nexit /b 0\r\n');
  } else {
    fs.writeFileSync(binPath, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
  }
  return binPath;
};

// 伪造 `codex login`，让 add 命令可以在测试里写入临时 auth.json。
const writeFakeCodexWithLogin = (binDir, email, extraPayload = {}) => {
  const authJson = JSON.stringify({
    tokens: {
      id_token: makeJwt(email),
      ...extraPayload,
    },
  });
  const binPath = path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    const escapedAuth = authJson.replace(/"/g, '\\"');
    fs.writeFileSync(
      binPath,
      `@echo off\r\nif "%1"=="login" (\r\n  mkdir "%CODEX_HOME%" 2>nul\r\n  > "%CODEX_HOME%\\auth.json" echo ${escapedAuth}\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n`,
    );
  } else {
    fs.writeFileSync(
      binPath,
      `#!/usr/bin/env sh
if [ "$1" = "login" ]; then
  mkdir -p "$CODEX_HOME"
  cat <<'EOF' > "$CODEX_HOME/auth.json"
${authJson}
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
  }
  return binPath;
};

// 通过真实 CLI 入口执行命令，覆盖参数解析和 stdout/stderr 行为。
const runCli = (args, options = {}) => {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CX_PROGRESS: '0',
      NO_COLOR: '1',
      ...options.env,
    },
    input: options.input,
  });
  return result;
};

test('help uses the codexs command name', () => {
  const result = runCli(['help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /codexs - Codex 账号切换助手/);
  assert.match(result.stdout, /codexs list\|l/);
  assert.doesNotMatch(result.stdout, /\bcx\b/);
});

test('list shows sorted accounts and marks the current account', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');

  writeAuth(path.join(accountsRoot, 'z@example.com'), 'z@example.com');
  writeAuth(path.join(accountsRoot, 'a@example.com'), 'a@example.com');
  writeAuth(path.join(home, '.codex'), 'a@example.com');

  const result = runCli(['list'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No\.\s+Account\s+Status/);
  assert.match(result.stdout, /1\*\s+a@example\.com\s+离线/);
  assert.match(result.stdout, /2\s+z@example\.com\s+离线/);
});

test('list ignores hidden account directories', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, '.backup'), 'backup@example.com');
  writeAuth(path.join(accountsRoot, 'a@example.com'), 'a@example.com');

  const result = runCli(['list'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\s+a@example\.com\s+离线/);
  assert.doesNotMatch(result.stdout, /backup@example\.com/);
});

test('list shows progress on stderr when progress is forced', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'a@example.com'), 'a@example.com');

  const result = runCli(['list'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '1',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /正在探活账号 1\/1：a@example\.com/);
});

test('codex-accounts.json stores only auth objects without derived identity fields', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'a@example.com'), 'a@example.com');

  const store = readAccountsFile(home);

  assert.equal(store.version, 1);
  assert.equal(store.accounts.length, 1);
  assert.deepEqual(Object.keys(store.accounts[0]), ['tokens']);
  assert.equal(store.accounts[0].tokens.id_token, makeJwt('a@example.com'));
});

test('list renders usage columns and light gray cooling rows', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'free@example.com'), 'free@example.com');

  const originalLoadUsage = usage.loadUsage;
  usage.loadUsage = async () => [{
    key: 'free@example.com',
    plan: 'free',
    h5_used: null,
    h5_reset: null,
    d7_used: 100,
    d7_reset: null,
  }];

  const originalNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  output.isTTY = true;

  try {
    await commands.listAccounts({
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '0',
    }, output);
  } finally {
    usage.loadUsage = originalLoadUsage;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  }

  const stdout = chunks.join('');
  assert.match(stdout, /No\.\s+Account\s+Plan\s+5h\s+7d/);
  assert.match(stdout, /\u001b\[1mNo\.\s+Account\s+Plan\s+5h\s+7d\s+\u001b\[0m/);
  assert.match(stdout, /\u001b\[38;2;230;230;230m1\s+free@example\.com\s+Free\s+-\s+0%/);
});

test('current account keeps its status color instead of selected color', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'current@example.com'), 'current@example.com');
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const originalLoadUsage = usage.loadUsage;
  usage.loadUsage = async () => [{
    key: 'current@example.com',
    plan: 'pro',
    h5_used: 100,
    h5_reset: null,
    d7_used: 20,
    d7_reset: null,
  }];

  const originalNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  output.isTTY = true;

  try {
    await commands.listAccounts({
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '0',
    }, output);
  } finally {
    usage.loadUsage = originalLoadUsage;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  }

  const stdout = chunks.join('');
  assert.match(stdout, /\u001b\[38;2;230;230;230m1\u001b\[0m\u001b\[32m\*\u001b\[0m\u001b\[38;2;230;230;230m\s+current@example\.com\s+Pro\s+0%/);
});

test('usage rows use status colors for limited cooling and offline accounts', () => {
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Free',
    d7Used: 100,
    h5Percent: '-',
    d7Percent: '0%',
  }), 'lightGray');
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Free',
    d7Used: 98,
    h5Percent: '-',
    d7Percent: '2%',
  }), 'lightYellow');
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Pro',
    h5Percent: '0%',
    d7Percent: '40%',
  }), 'lightGray');
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Pro',
    h5Used: 0,
    h5Percent: '100%',
    d7Percent: '40%',
  }), '');
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Pro',
    h5Percent: '30%',
    d7Percent: '0%',
  }), 'lightGray');
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Pro',
    h5Percent: '30%',
    d7Percent: '40%',
  }), '');
  assert.equal(getUsageRowColor({
    isOffline: true,
    planLabel: 'Pro',
    h5Percent: '30%',
    d7Percent: '40%',
  }), 'lightRed');
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Pro',
    h5Used: 98,
    h5Percent: '2%',
    d7Percent: '40%',
  }), 'lightYellow');
  assert.equal(getUsageRowColor({
    isOffline: false,
    planLabel: 'Pro',
    h5Used: 100,
    h5Percent: '0%',
    d7Percent: '40%',
  }), 'lightGray');
});

test('account usage state classifies paid quota windows', () => {
  assert.equal(usage.getAccountUsageState({
    plan: 'pro',
    h5_used: 2,
    d7_used: 99,
  }), ACCOUNT_USAGE_STATES.AVAILABLE);
  assert.equal(usage.getAccountUsageState({
    plan: 'pro',
    h5_used: 20,
    d7_used: 40,
  }), ACCOUNT_USAGE_STATES.AVAILABLE);
  assert.equal(usage.getAccountUsageState({
    plan: 'pro',
    h5_used: 97,
    d7_used: 40,
  }), ACCOUNT_USAGE_STATES.LIMITED);
  assert.equal(usage.getAccountUsageState({
    plan: 'pro',
    h5_used: 2,
    d7_used: 100,
  }), ACCOUNT_USAGE_STATES.COOLING);
});

test('account usage state classifies missing usage as offline', () => {
  assert.equal(usage.getAccountUsageState(null), ACCOUNT_USAGE_STATES.OFFLINE);
  assert.equal(usage.getAccountUsageState({ key: 'offline@example.com', error: 'timeout' }), ACCOUNT_USAGE_STATES.OFFLINE);
});

test('auto switch triggers for limited cooling or offline current accounts', () => {
  const results = [
    { key: 'available@example.com', plan: 'pro', h5_used: 2, d7_used: 40 },
    { key: 'mid-available@example.com', plan: 'pro', h5_used: 50, d7_used: 40 },
    { key: 'limited@example.com', plan: 'pro', h5_used: 98, d7_used: 40 },
    { key: 'cooling@example.com', plan: 'pro', h5_used: 100, d7_used: 40 },
    { key: 'offline@example.com', error: 'timeout' },
  ];

  assert.equal(usage.accountShouldAutoSwitch(results, 'available@example.com'), false);
  assert.equal(usage.accountShouldAutoSwitch(results, 'mid-available@example.com'), false);
  assert.equal(usage.accountShouldAutoSwitch(results, 'limited@example.com'), true);
  assert.equal(usage.accountShouldAutoSwitch(results, 'cooling@example.com'), true);
  assert.equal(usage.accountShouldAutoSwitch(results, 'offline@example.com'), true);
});

test('probe account status uses usage endpoint response status', async () => {
  const home = makeTempHome();
  const accountHome = path.join(home, '.codex-accounts', 'online@example.com');
  writeUsageAuth(accountHome, 'online@example.com');

  assert.equal(await usage.probeAccountStatus(accountHome, async () => ({
    ok: true,
    status: 200,
  })), 'online');
  assert.equal(await usage.probeAccountStatus(accountHome, async () => ({
    ok: false,
    status: 401,
  })), 'offline');
  assert.equal(await usage.probeAccountStatus(accountHome, async () => ({
    ok: false,
    status: 500,
  })), 'unknown');
});

test('list rejects symlinked codex-accounts.json', () => {
  if (process.platform === 'win32') return;

  const home = makeTempHome();
  const codexHome = path.join(home, '.codex');
  const externalStore = path.join(home, 'external-codex-accounts.json');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(externalStore, '{"version":1,"accounts":[]}');
  fs.symlinkSync(externalStore, path.join(codexHome, 'codex-accounts.json'));

  const result = runCli(['list'], {
    env: {
      HOME: home,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /拒绝读取符号链接账号库/);
});

test('remove shows indexed progress while probing accounts', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'offline@example.com'), 'offline@example.com');

  const result = runCli(['remove'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '1',
    },
    input: 'x\n',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /正在检测账号 1\/1：offline@example\.com/);
});

test('remove without selector does not require codex binary for probing', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'offline@example.com'), 'offline@example.com');

  const result = runCli(['remove'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '1',
    },
    input: 'x\n',
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /找不到 codex/);
});

test('confirmation reports invalid input distinctly', async () => {
  const { confirmRemoval } = require('../src/terminal');
  const input = new PassThrough();
  input.isTTY = true;
  input.end('x\n');
  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  const confirmed = await confirmRemoval('offline@example.com', input, output);

  assert.equal(confirmed, false);
  assert.match(chunks.join(''), /输入无效，已取消删除离线账号：offline@example\.com/);
});

test('use without selector shows progress when checking current account quota', async () => {
  const { withProgress } = require('../src/terminal');
  const messages = [];
  const env = { CX_PROGRESS: '1' };
  const stream = {
    write(value) {
      messages.push(value);
    },
  };

  await withProgress('正在检查当前账号额度：current@example.com', () => undefined, env, stream);

  assert.match(messages.join(''), /正在检查当前账号额度：current@example\.com/);
});

test('use without selector keeps current account when no available account exists', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'current@example.com'), 'current@example.com');
  writeAuth(path.join(accountsRoot, 'other@example.com'), 'other@example.com');
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const originalLoadUsage = usage.loadUsage;
  usage.loadUsage = async () => ([
    { key: 'current@example.com', plan: 'pro', h5_used: 98, h5_reset: null, d7_used: 0, d7_reset: null },
    { key: 'other@example.com', plan: 'pro', h5_used: 99, h5_reset: null, d7_used: 0, d7_reset: null },
  ]);

  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  try {
    await commands.useDefaultAccount({
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '0',
    }, output);
  } finally {
    usage.loadUsage = originalLoadUsage;
  }

  const activeAuth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.equal(activeAuth.tokens.id_token, makeJwt('current@example.com'));
  assert.match(chunks.join(''), /当前 Codex 账号没有 available 替代账号：current@example\.com，未切换账号。/);
});

test('use without selector keeps current account while current state is available', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'current@example.com'), 'current@example.com');
  writeAuth(path.join(accountsRoot, 'better@example.com'), 'better@example.com');
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const originalLoadUsage = usage.loadUsage;
  usage.loadUsage = async () => ([
    { key: 'better@example.com', plan: 'pro', h5_used: 20, h5_reset: null, d7_used: 0, d7_reset: null },
    { key: 'current@example.com', plan: 'pro', h5_used: 50, h5_reset: null, d7_used: 40, d7_reset: null },
  ]);

  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  try {
    await commands.useDefaultAccount({
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '0',
    }, output);
  } finally {
    usage.loadUsage = originalLoadUsage;
  }

  const activeAuth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.equal(activeAuth.tokens.id_token, makeJwt('current@example.com'));
  assert.match(chunks.join(''), /当前 Codex 账号状态无需自动切换：current@example\.com，未切换账号。/);
});

test('use without selector switches to an available account when current state is limited', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'current@example.com'), 'current@example.com');
  writeAuth(path.join(accountsRoot, 'better@example.com'), 'better@example.com');
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const originalLoadUsage = usage.loadUsage;
  usage.loadUsage = async () => ([
    { key: 'better@example.com', plan: 'pro', h5_used: 2, h5_reset: null, d7_used: 0, d7_reset: null },
    { key: 'current@example.com', plan: 'pro', h5_used: 98, h5_reset: null, d7_used: 0, d7_reset: null },
  ]);

  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  try {
    await commands.useDefaultAccount({
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '0',
    }, output);
  } finally {
    usage.loadUsage = originalLoadUsage;
  }

  const activeAuth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.equal(activeAuth.tokens.id_token, makeJwt('better@example.com'));
  assert.match(chunks.join(''), /已切换 Codex 账号：better@example\.com/);
});

test('use without selector skips paid accounts whose 7d quota is cooling', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'current@example.com'), 'current@example.com');
  writeAuth(path.join(accountsRoot, 'a-cooldown@example.com'), 'a-cooldown@example.com');
  writeAuth(path.join(accountsRoot, 'z-better@example.com'), 'z-better@example.com');
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const originalLoadUsage = usage.loadUsage;
  usage.loadUsage = async () => ([
    { key: 'a-cooldown@example.com', plan: 'pro', h5_used: 10, h5_reset: null, d7_used: 100, d7_reset: null },
    { key: 'z-better@example.com', plan: 'pro', h5_used: 2, h5_reset: null, d7_used: 40, d7_reset: null },
    { key: 'current@example.com', plan: 'pro', h5_used: 98, h5_reset: null, d7_used: 40, d7_reset: null },
  ]);

  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  try {
    await commands.useDefaultAccount({
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '0',
    }, output);
  } finally {
    usage.loadUsage = originalLoadUsage;
  }

  const activeAuth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.equal(activeAuth.tokens.id_token, makeJwt('z-better@example.com'));
  assert.doesNotMatch(chunks.join(''), /已切换 Codex 账号：a-cooldown@example\.com/);
  assert.match(chunks.join(''), /已切换 Codex 账号：z-better@example\.com/);
});

test('use without selector switches to first available account without comparing quota', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'current@example.com'), 'current@example.com');
  writeAuth(path.join(accountsRoot, 'a-higher@example.com'), 'a-higher@example.com');
  writeAuth(path.join(accountsRoot, 'z-available@example.com'), 'z-available@example.com');
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const originalLoadUsage = usage.loadUsage;
  usage.loadUsage = async () => ([
    { key: 'a-higher@example.com', plan: 'pro', h5_used: 50, h5_reset: null, d7_used: 0, d7_reset: null },
    { key: 'z-available@example.com', plan: 'pro', h5_used: 2, h5_reset: null, d7_used: 0, d7_reset: null },
    { key: 'current@example.com', plan: 'pro', h5_used: 98, h5_reset: null, d7_used: 40, d7_reset: null },
  ]);

  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  try {
    await commands.useDefaultAccount({
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CX_PROGRESS: '0',
    }, output);
  } finally {
    usage.loadUsage = originalLoadUsage;
  }

  const activeAuth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.equal(activeAuth.tokens.id_token, makeJwt('a-higher@example.com'));
  assert.match(chunks.join(''), /已切换 Codex 账号：a-higher@example\.com/);
  assert.doesNotMatch(chunks.join(''), /已切换 Codex 账号：z-available@example\.com/);
});

test('use copies selected account auth into the active Codex slot', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'b@example.com'), 'b@example.com');

  const result = runCli(['use', '1'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已切换 Codex 账号：b@example\.com/);

  const activeAuth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.equal(activeAuth.tokens.id_token, makeJwt('b@example.com'));
});

test('validateName rejects non-email account names', () => {
  assert.throws(() => validateName('foo'), /账号只能是邮箱/);
  assert.throws(() => validateName('demo_1'), /账号只能是邮箱/);
  assert.doesNotThrow(() => validateName('ok@example.com'));
});

test('use rejects legacy non-email selectors', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuth(path.join(accountsRoot, 'legacy_name'), 'legacy@example.com');

  const result = runCli(['use', 'legacy_name'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /账号只能是邮箱/);
});

test('list shows short account_id when email is missing', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuthWithIdentity(
    path.join(accountsRoot, 'stored-dir'),
    {},
    { account_id: '6b17e1c8-12c3-4dea-a754-268a3be6e690' },
  );

  const result = runCli(['list'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\s+6b17e1c8\s+离线/);
});

test('use accepts short account_id selector when email is missing', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  writeAuthWithIdentity(
    path.join(accountsRoot, 'stored-dir'),
    {},
    { account_id: '6b17e1c8-12c3-4dea-a754-268a3be6e690' },
  );

  const result = runCli(['use', '6b17e1c8'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已切换 Codex 账号：6b17e1c8/);
});

test('init syncs the active Codex account without jq', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexBin = writeFakeCodex(binDir);
  writeAuth(path.join(home, '.codex'), 'init@example.com');

  const result = runCli(['init'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已同步当前 Codex 账号：init@example\.com/);
  assert.deepEqual(readAccounts({ HOME: home }).map((account) => account.id), ['init@example.com']);
});

test('init imports legacy .codex-accounts into codex-accounts.json', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexBin = writeFakeCodex(binDir);
  writeLegacyAuth(path.join(accountsRoot, 'legacy@example.com'), 'legacy@example.com');
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const result = runCli(['init'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已从旧账号库迁移账号：1 个/);
  assert.deepEqual(
    readAccounts({ HOME: home }).map((account) => account.id).sort(),
    ['current@example.com', 'legacy@example.com'],
  );
  assert.equal(fs.existsSync(accountsRoot), false);
});

test('init migration keeps existing codex-accounts.json accounts when legacy duplicates exist', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexBin = writeFakeCodex(binDir);
  writeAuth(path.join(accountsRoot, 'same@example.com'), 'same@example.com', { refresh_token: 'new' });
  writeLegacyAuth(path.join(accountsRoot, 'same@example.com'), 'same@example.com', { refresh_token: 'old' });
  writeAuth(path.join(home, '.codex'), 'current@example.com');

  const result = runCli(['init'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const existing = readAccounts({ HOME: home }).find((account) => account.id === 'same@example.com');
  assert.equal(existing.auth.tokens.refresh_token, 'new');
  assert.equal(fs.existsSync(accountsRoot), false);
});

test('add overwrites an existing account with the new login result', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexBin = writeFakeCodexWithLogin(binDir, 'existing@example.com', { refresh_token: 'new-token' });
  writeAuth(path.join(accountsRoot, 'existing@example.com'), 'existing@example.com', { refresh_token: 'old-token' });

  const result = runCli(['add'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已覆盖已有账号：existing@example\.com/);

  const auth = readAccounts({ HOME: home })[0].auth;
  assert.equal(auth.tokens.refresh_token, 'new-token');
  assert.deepEqual(readAccounts({ HOME: home }).map((account) => account.id), ['existing@example.com']);
});

test('add reports codex login failure details', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexBin = path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    fs.writeFileSync(codexBin, '@echo off\r\nexit /b 7\r\n');
  } else {
    fs.writeFileSync(codexBin, '#!/usr/bin/env sh\nexit 7\n', { mode: 0o755 });
  }

  const result = runCli(['add'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /codex login 执行失败/);
  assert.match(result.stderr, /codex 路径：/);
  assert.match(result.stderr, /退出码：7/);
  assert.match(result.stderr, /请先单独运行确认 Codex CLI 可登录：/);
  assert.deepEqual(readAccounts({ HOME: home }), []);
});

test('add falls back to short account_id when email is missing', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexBin = writeFakeCodexWithLogin(
    binDir,
    {},
    { account_id: '6b17e1c8-12c3-4dea-a754-268a3be6e690' },
  );

  const result = runCli(['add'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已添加账号：6b17e1c8/);
  assert.deepEqual(readAccounts({ HOME: home }).map((account) => account.id), ['6b17e1c8']);
});

test('init falls back to short account_id when email is missing', () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexBin = writeFakeCodex(binDir);
  writeAuthWithIdentity(
    path.join(home, '.codex'),
    {},
    { account_id: '6b17e1c8-12c3-4dea-a754-268a3be6e690' },
  );

  const result = runCli(['init'], {
    env: {
      HOME: home,
      CODEX_ACCOUNTS_ROOT: accountsRoot,
      CODEX_BIN: codexBin,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已同步当前 Codex 账号：6b17e1c8/);
  assert.deepEqual(readAccounts({ HOME: home }).map((account) => account.id), ['6b17e1c8']);
});

test('probe account status returns offline when auth.json missing and unknown when fetch unavailable', async () => {
  const home = makeTempHome();
  const noAuthDir = path.join(home, '.codex-accounts', 'noauth@example.com');
  fs.mkdirSync(noAuthDir, { recursive: true });
  assert.equal(await usage.probeAccountStatus(noAuthDir, async () => ({ ok: true })), 'offline');

  const accountDir = path.join(home, '.codex-accounts', 'has@example.com');
  writeUsageAuth(accountDir, 'has@example.com');
  // fetchImpl 不可用时应返回 unknown，而不是 offline。
  assert.equal(await usage.probeAccountStatus(accountDir, null), 'unknown');
});

test('probe rejects symlinked auth.json (usage path symlink defense)', async () => {
  if (process.platform === 'win32') return;
  const home = makeTempHome();
  const realDir = path.join(home, 'real');
  writeUsageAuth(realDir, 'real@example.com');
  const accountDir = path.join(home, '.codex-accounts', 'real@example.com');
  fs.mkdirSync(accountDir, { recursive: true });
  fs.symlinkSync(path.join(realDir, 'auth.json'), path.join(accountDir, 'auth.json'));

  // 应被 readAuth 的 symlink 防护拦截 → 返回 offline（视为没有可用凭据）。
  let fetchCalled = false;
  const status = await usage.probeAccountStatus(accountDir, async () => {
    fetchCalled = true;
    return { ok: true, status: 200 };
  });
  assert.equal(status, 'offline');
  assert.equal(fetchCalled, false);
});

test('getHomeDir handles Windows-style envs and msys HOME', () => {
  const { getHomeDir } = require('../src/paths');
  // 非 Windows 平台只能验证 POSIX 路径；Windows 平台验证 USERPROFILE / msys 兼容。
  if (process.platform === 'win32') {
    assert.equal(getHomeDir({ USERPROFILE: 'C:\\Users\\foo' }), 'C:\\Users\\foo');
    assert.equal(getHomeDir({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\bar' }), 'C:\\Users\\bar');
    assert.equal(getHomeDir({ HOME: '/c/Users/baz' }), 'C:\\Users\\baz');
  } else {
    assert.equal(getHomeDir({ HOME: '/home/foo' }), '/home/foo');
  }
});

test('vscode codex lookup only uses compatible platform bins', () => {
  const { findCodexBin, __test } = require('../src/codex');
  const home = makeTempHome();
  const binDir = path.join(
    home,
    '.vscode',
    'extensions',
    `openai.chatgpt-test-${__test.compatibleVscodePlatformNames()[0]}`,
    'bin',
  );
  const compatibleName = __test.compatibleVscodePlatformNames()[0];
  const compatibleDir = path.join(binDir, compatibleName);
  const incompatibleDir = path.join(binDir, 'linux-x86_64');
  const executableName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  fs.mkdirSync(compatibleDir, { recursive: true });
  fs.mkdirSync(incompatibleDir, { recursive: true });
  fs.writeFileSync(path.join(incompatibleDir, 'codex'), 'not for this platform');
  fs.writeFileSync(path.join(compatibleDir, executableName), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });

  const codexBin = findCodexBin({ HOME: home, PATH: '' });

  assert.equal(codexBin, path.join(compatibleDir, executableName));
  assert.equal(
    __test.platformNameFromExtension('openai.chatgpt-26.422.30944-win32-x64'),
    'win32-x64',
  );
  assert.equal(
    __test.orderedVscodePlatformNames('openai.chatgpt-26.422.30944-win32-x64', 'win32', 'x64')[0],
    'win32-x64',
  );
  assert.equal(
    __test.orderedVscodePlatformNames('openai.chatgpt-26.422.30944-linux-x86_64', 'win32', 'x64')[0],
    'win32-x64',
  );
  assert.ok(__test.compatibleVscodePlatformNames('win32', 'x64').includes('win32-x64'));
  assert.ok(!__test.compatibleVscodePlatformNames('win32', 'x64').includes('linux-x86_64'));
});

test('use without selector reports empty account store instead of failing on usage', async () => {
  const home = makeTempHome();
  const accountsRoot = path.join(home, '.codex-accounts');
  fs.mkdirSync(accountsRoot, { recursive: true });

  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  await commands.useDefaultAccount({
    HOME: home,
    CODEX_ACCOUNTS_ROOT: accountsRoot,
    CX_PROGRESS: '0',
  }, output);

  assert.match(chunks.join(''), /还没有账号/);
});

test('writeFileAtomically leaves no temp residue and refuses to overwrite a symlink', () => {
  const { writeFileAtomically } = require('../src/paths');
  const home = makeTempHome();
  const targetDir = path.join(home, 'dst');
  fs.mkdirSync(targetDir, { recursive: true });
  const data = '{"k":1}';

  writeFileAtomically(path.join(targetDir, 'auth.json'), data);
  const remaining = fs.readdirSync(targetDir);
  assert.deepEqual(remaining, ['auth.json']);
  assert.equal(fs.readFileSync(path.join(targetDir, 'auth.json'), 'utf8'), data);

  if (process.platform !== 'win32') {
    const externalTarget = path.join(home, 'external.json');
    fs.writeFileSync(externalTarget, 'old');
    const linkPath = path.join(targetDir, 'auth.json');
    fs.unlinkSync(linkPath);
    fs.symlinkSync(externalTarget, linkPath);
    assert.throws(() => writeFileAtomically(linkPath, data), /符号链接/);
    // 拒绝后不能污染 external 文件。
    assert.equal(fs.readFileSync(externalTarget, 'utf8'), 'old');
    // 拒绝后 targetDir 也不应残留 .tmp.* 文件。
    const after = fs.readdirSync(targetDir);
    assert.deepEqual(after.filter((n) => n.includes('.tmp.')), []);
  }
});
