const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findCodexBin } = require('./codex');
const {
  assertNotSymlink,
  ensureDir,
  ensureReadableFile,
  getCodexHome,
  writeFileAtomically,
} = require('./paths');
const {
  currentAccount,
  currentSlotLabel,
  displayAccount,
  importLegacyAccounts,
  readAccounts,
  removeAccountEntry,
  resolveAccount,
  upsertAccount,
} = require('./accounts');
const { decodeAccountLabel, readAuth } = require('./auth');
const usage = require('./usage');
const term = require('./terminal');

// init 先做环境预检，失败时暴露真实缺失项而不是继续写账号库。
const runInitChecks = (env = process.env) => {
  findCodexBin(env);
  const codexHome = getCodexHome(env);
  const authPath = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(codexHome)) throw new Error(`Codex 目录不存在：${codexHome}`);
  assertNotSymlink(codexHome, '拒绝读取符号链接目录');
  ensureReadableFile(authPath);
};

const syncCurrentAccount = (env = process.env, output = process.stdout) => {
  const codexHome = getCodexHome(env);
  const { account, overwritten } = upsertAccount(readAuth(codexHome), env);
  if (overwritten) {
    output.write(`账号已存在：${displayAccount(account)}，已更新：${path.join(codexHome, 'codex-accounts.json')}\n`);
    return;
  }
  output.write(`已同步当前 Codex 账号：${displayAccount(account)}，已写入：${path.join(codexHome, 'codex-accounts.json')}\n`);
};

const initAccounts = (env = process.env, output = process.stdout) => {
  runInitChecks(env);
  const migration = importLegacyAccounts(env);
  if (migration.imported > 0) output.write(`已从旧账号库迁移账号：${migration.imported} 个，`);
  if (migration.removedLegacyRoot) output.write('已删除旧账号库，');
  output.write('环境检查通过，');
  syncCurrentAccount(env, output);
};

// 清理登录中断遗留的临时目录，只处理 `.login.*` 且跳过符号链接。
const removeLoginTempDirs = (env = process.env) => {
  const root = getCodexHome(env);
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('.login.')) continue;
    const dir = path.join(root, name);
    if (!fs.lstatSync(dir).isSymbolicLink()) fs.rmSync(dir, { recursive: true, force: true });
  }
};

const useAccount = (selector, env = process.env, output = process.stdout) => {
  const account = resolveAccount(selector, env);
  if (!account) throw new Error(`账号不存在：${selector}`);
  const codexHome = getCodexHome(env);
  ensureDir(codexHome);
  writeFileAtomically(path.join(codexHome, 'auth.json'), `${JSON.stringify(account.auth, null, 2)}\n`);
  output.write(`已切换 Codex 账号：${displayAccount(account)}，已更新：${path.join(codexHome, 'auth.json')}；VS Code Codex 可能需要 Reload Window 或重启 VS Code 后生效。\n`);
};

const removeAccountFromStore = (account, message, env = process.env, output = process.stdout) => {
  const accountLabel = displayAccount(account);
  removeAccountEntry(account, env);
  removeLoginTempDirs(env);
  output.write(`${message}：${accountLabel}\n`);
};

const removeAccount = (selector, env = process.env, output = process.stdout) => {
  const account = resolveAccount(selector, env);
  if (!account) throw new Error(`账号不存在：${selector}`);
  removeAccountFromStore(account, '已删除账号', env, output);
};

const writeEmptyAccountsMessage = (env = process.env, output = process.stdout) => {
  output.write(`（${path.join(getCodexHome(env), 'codex-accounts.json')} 里还没有账号）\n`);
};

const formatCodexLoginFailure = (codexBin, result) => {
  const details = [
    'codex login 执行失败',
    `codex 路径：${codexBin}`,
    `退出码：${result.status ?? '未知'}`,
  ];
  if (result.signal) details.push(`终止信号：${result.signal}`);
  if (result.error) details.push(`错误信息：${result.error.message}`);
  details.push(`请先单独运行确认 Codex CLI 可登录：${codexBin} login`);
  return details.join('\n');
};

// 批量删除只处理探活确认离线的账号，每个账号仍逐个交互确认。
const removeOfflineAccounts = async (
  env = process.env,
  output = process.stdout,
  input = process.stdin,
  errOutput = process.stderr,
) => {
  ensureDir(getCodexHome(env));
  removeLoginTempDirs(env);
  const accounts = readAccounts(env);
  if (accounts.length === 0) {
    writeEmptyAccountsMessage(env, output);
    return;
  }

  let removed = 0;
  let abortedReason = '';
  for (const [index, account] of accounts.entries()) {
    const accountLabel = displayAccount(account);
    const status = await term.withProgress(
      `正在检测账号 ${index + 1}/${accounts.length}：${accountLabel}`,
      () => usage.probeAccountStatus(account),
      env,
    );
    if (status === 'unknown') {
      errOutput.write(`无法确认账号在线状态，已跳过：${accountLabel}\n`);
      continue;
    }
    if (status !== 'offline') continue;
    let confirmed = false;
    try {
      confirmed = await term.confirmRemoval(accountLabel, input, output);
    } catch (error) {
      abortedReason = error && error.message ? error.message : String(error);
      break;
    }
    if (!confirmed) continue;
    removeAccountFromStore(account, '已删除离线账号', env, output);
    removed += 1;
  }
  if (removed > 0) output.write(`本次共删除离线账号：${removed}\n`);
  else if (!abortedReason) output.write('没有离线账号可删除\n');
  if (abortedReason) {
    // 已删账号摘要先写到 stdout，再抛错让 main 设非零退出码。
    throw new Error(`${abortedReason}（已删除 ${removed} 个，剩余离线账号未处理）`);
  }
};

// Windows 下 `.cmd/.bat` 不能直接 spawn，需要走 cmd.exe 包装。
const runCodexLogin = (codexBin, env) => {
  const childEnv = { ...env, CODEX_HOME: env.CODEX_HOME };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin)) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return spawnSync(
      comspec,
      ['/d', '/s', '/c', `"${codexBin}" login`],
      { stdio: 'inherit', env: childEnv, windowsVerbatimArguments: true },
    );
  }
  return spawnSync(codexBin, ['login'], { stdio: 'inherit', env: childEnv });
};

// 使用临时 CODEX_HOME 完成登录，成功后再移动到账号仓库。
const addAccount = async (env = process.env, output = process.stdout) => {
  const codexBin = findCodexBin(env);
  const root = getCodexHome(env);
  ensureDir(root);
  const tempHome = fs.mkdtempSync(path.join(root, '.login.'));
  let keepTempHome = false;
  try {
    const result = runCodexLogin(codexBin, { ...env, CODEX_HOME: tempHome });
    if (result.status !== 0) throw new Error(formatCodexLoginFailure(codexBin, result));
    const auth = readAuth(tempHome);
    const accountLabel = decodeAccountLabel(tempHome);
    if (!accountLabel || !auth) {
      keepTempHome = true;
      throw new Error(`登录完成，但未能从 auth.json 解析出邮箱或短 ID\n临时目录保留在：${tempHome}`);
    }
    const { overwritten } = upsertAccount(auth, env);
    fs.rmSync(tempHome, { recursive: true, force: true });
    if (overwritten) {
      output.write(`已覆盖已有账号：${accountLabel}\n`);
      return;
    }
    output.write(`已添加账号：${accountLabel}\n`);
  } catch (error) {
    if (!keepTempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    throw error;
  }
};

// 当前账号进入 limited/cooling/offline 后，才尝试切到第一个 available 账号。
const useDefaultAccount = async (env = process.env, output = process.stdout) => {
  const accounts = readAccounts(env);
  if (accounts.length === 0) {
    writeEmptyAccountsMessage(env, output);
    return;
  }
  const usageResults = await term.withProgress('正在查询账号额度...', () => usage.loadUsage(accounts), env);
  if (!usage.hasUsageData(usageResults)) throw new Error('无法查询账号额度，未切换账号');
  const activeAccount = currentAccount(env);
  const currentKey = activeAccount ? activeAccount.id : '';
  if (activeAccount && !usage.accountShouldAutoSwitch(usageResults, currentKey)) {
    output.write(`当前 Codex 账号状态无需自动切换：${displayAccount(activeAccount)}，未切换账号。\n`);
    return;
  }
  const next = await term.withProgress(
    activeAccount ? `正在检查当前账号额度：${displayAccount(activeAccount)}` : '正在选择 available 账号...',
    () => findFirstAvailableAccount(accounts, usageResults, currentKey),
    env,
  );
  if (!next) {
    if (activeAccount) {
      output.write(`当前 Codex 账号没有 available 替代账号：${displayAccount(activeAccount)}，未切换账号。\n`);
      return;
    }
    throw new Error('没有找到 available 账号，未切换账号');
  }
  useAccount(next.id, env, output);
};

const getUsageRowColor = ({ isOffline, planLabel, h5Used, d7Used, h5Percent, d7Percent }) => {
  if (isOffline) return 'lightRed';
  if (planLabel === 'Free') {
    if (d7Used >= 100 || d7Percent === '0%') return 'lightGray';
    if (d7Used >= 97) return 'lightYellow';
    return '';
  }
  if (h5Used >= 100 || h5Percent === '0%' || d7Percent === '0%') return 'lightGray';
  if (h5Used >= 97) return 'lightYellow';
  return '';
};

const findFirstAvailableAccount = (accounts, usageResults, currentKey = '') => {
  return accounts.find((account) => {
    if (account.id === currentKey) return false;
    return usage.accountIsAvailableForAutoSwitch(usageResults, account.id);
  });
};

const lightStatusLabel = (account) => {
  return account && account.auth ? '已登录' : '未登录';
};

// 组装列表行数据；已有 Usage 数据时不再额外探活。
const buildAccountRow = async (account, index, total, activeLabel, usageResults, env) => {
  const accountLabel = displayAccount(account);
  const key = account.id;
  let status = lightStatusLabel(account);
  let isOffline = false;
  const isCurrent = Boolean(activeLabel && accountLabel === activeLabel);

  if (status === '已登录' && !usage.usageAvailableForAccount(usageResults, key)) {
    const probeStatus = await term.withProgress(`正在探活账号 ${index}/${total}：${accountLabel}`, () => usage.probeAccountStatus(account), env);
    if (probeStatus === 'offline') {
      status = '离线';
      isOffline = true;
    } else if (probeStatus === 'unknown') {
      status = '未知';
    }
  }

  return { account: accountLabel, isCurrent, isOffline, key, status, indexDisplay: term.formatListIndex(index, isCurrent) };
};

const loadAccountRows = async (accounts, activeLabel, usageResults, env = process.env) => {
  return Promise.all(accounts.map((account, index) => {
    return buildAccountRow(account, index + 1, accounts.length, activeLabel, usageResults, env);
  }));
};

const buildUsageColumns = (item) => {
  const planLabel = term.formatPlanType(item.plan);
  const h5Percent = term.formatUsagePercent(item.h5_used);
  const d7Percent = term.formatUsagePercent(item.d7_used);
  const h5Column = h5Percent !== '-' && item.h5_reset
    ? `${h5Percent} (${term.formatResetTime(item.h5_reset, 'time')})`
    : h5Percent;
  const d7Column = d7Percent !== '-' && item.d7_reset
    ? `${d7Percent} (${term.formatResetTime(item.d7_reset, 'date')})`
    : d7Percent;

  return { d7Column, d7Percent, h5Column, h5Percent, planLabel };
};

const renderUsageRow = (row, item, accountWidth, output = process.stdout) => {
  const { d7Column, d7Percent, h5Column, h5Percent, planLabel } = buildUsageColumns(item);
  const statusColor = getUsageRowColor({
    d7Percent,
    isOffline: row.isOffline,
    planLabel,
    d7Used: item.d7_used,
    h5Used: item.h5_used,
    h5Percent,
  });
  const line = `${term.pad(row.indexDisplay, term.INDEX_WIDTH)} ${term.pad(row.account, accountWidth)} ${term.pad(planLabel, term.PLAN_WIDTH)} ${term.pad(h5Column, term.USAGE_WIDTH)} ${term.pad(d7Column, term.USAGE_WIDTH)}`;
  term.printRow(line, { isCurrent: row.isCurrent, color: statusColor }, output);
};

const renderStatusRow = (row, accountWidth, output = process.stdout) => {
  const line = `${term.pad(row.indexDisplay, term.INDEX_WIDTH)} ${term.pad(row.account, accountWidth)} ${term.pad(row.status, term.STATUS_WIDTH)}`;
  term.printRow(line, { isCurrent: row.isCurrent, color: row.isOffline ? 'lightRed' : '' }, output);
};

const listAccounts = async (env = process.env, output = process.stdout) => {
  ensureDir(getCodexHome(env));
  const accounts = readAccounts(env);
  const activeLabel = currentSlotLabel(env);
  const usageResults = await term.withProgress('正在查询账号额度...', () => usage.loadUsage(accounts), env);
  const hasUsage = usage.hasUsageData(usageResults);
  const rows = await loadAccountRows(accounts, activeLabel, usageResults, env);
  const accountWidth = Math.max('Account'.length, ...rows.map((r) => r.account.length));

  const header = hasUsage
    ? `${term.pad('No.', term.INDEX_WIDTH)} ${term.pad('Account', accountWidth)} ${term.pad('Plan', term.PLAN_WIDTH)} ${term.pad('5h', term.USAGE_WIDTH)} ${term.pad('7d', term.USAGE_WIDTH)}`
    : `${term.pad('No.', term.INDEX_WIDTH)} ${term.pad('Account', accountWidth)} ${term.pad('Status', term.STATUS_WIDTH)}`;
  output.write(`${term.bold(header, env, output)}\n`);

  for (const row of rows) {
    const item = usage.usageFor(usageResults, row.key) || {};
    if (hasUsage) renderUsageRow(row, item, accountWidth, output);
    else renderStatusRow(row, accountWidth, output);
  }
  if (rows.length === 0) writeEmptyAccountsMessage(env, output);
};

module.exports = {
  addAccount,
  getUsageRowColor,
  initAccounts,
  listAccounts,
  removeAccount,
  removeOfflineAccounts,
  useAccount,
  useDefaultAccount,
};
