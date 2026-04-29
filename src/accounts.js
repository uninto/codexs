const fs = require('node:fs');
const path = require('node:path');
const {
  assertNotSymlink,
  getAccountsFile,
  getAccountsRoot,
  getCodexHome,
  writeFileAtomically,
} = require('./paths');
const {
  decodeAccountEmailFromAuth,
  decodeAccountLabel,
  decodeShortAccountIdFromAuth,
  readAuth,
} = require('./auth');

const STORE_VERSION = 1;
const SHORT_ACCOUNT_ID = /^[a-f0-9]{8}$/i;

// 校验外部传入的账号标识，避免路径穿越和隐藏目录误用。
const validateName = (name) => {
  if (!name) throw new Error('缺少账号参数');
  if (name === '.' || name === '..' || name.startsWith('.') || name.includes('/')) {
    throw new Error('账号名不能是 .、..、以 . 开头，且不能包含 /');
  }
  const email = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
  if (!email.test(name) && !SHORT_ACCOUNT_ID.test(name)) throw new Error('账号只能是邮箱或短 ID');
};

const displayAccount = (account) => {
  return account.email || account.shortId || account.id;
};

const normalizeAccount = (auth) => {
  const email = decodeAccountEmailFromAuth(auth);
  const shortId = decodeShortAccountIdFromAuth(auth);
  const id = email || shortId;
  if (!id) throw new Error('未能从 auth.json 解析出邮箱或短 ID');
  return { auth, email, id, shortId };
};

const accountMatches = (account, selector) => {
  return [account.id, account.email, account.shortId, displayAccount(account)].includes(selector);
};

const readAccounts = (env = process.env) => {
  const filePath = getAccountsFile(env);
  const codexHome = getCodexHome(env);
  if (!fs.existsSync(filePath)) return [];
  assertNotSymlink(codexHome, '拒绝读取符号链接目录');
  assertNotSymlink(filePath, '拒绝读取符号链接账号库');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!data || data.version !== STORE_VERSION || !Array.isArray(data.accounts)) {
    throw new Error(`账号库格式无效：${filePath}`);
  }
  return data.accounts.map((auth) => normalizeAccount(auth));
};

const writeAccounts = (accounts, env = process.env) => {
  const filePath = getAccountsFile(env);
  const codexHome = getCodexHome(env);
  if (!fs.existsSync(codexHome)) fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  assertNotSymlink(codexHome, '拒绝写入符号链接目录');
  assertNotSymlink(filePath, '拒绝覆盖符号链接账号库');
  const sorted = [...accounts].sort((a, b) => displayAccount(a).localeCompare(displayAccount(b), 'en'));
  const payload = {
    version: STORE_VERSION,
    accounts: sorted.map(({ auth }) => auth),
  };
  writeFileAtomically(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const upsertAccount = (auth, env = process.env) => {
  const next = normalizeAccount(auth);
  const current = readAccounts(env);
  const overwritten = current.some((account) => account.id === next.id);
  const accounts = current.filter((account) => account.id !== next.id);
  writeAccounts([...accounts, next], env);
  return { account: next, overwritten };
};

const removeAccountEntry = (account, env = process.env) => {
  writeAccounts(readAccounts(env).filter((item) => item.id !== account.id), env);
};

const resolveAccount = (selector, env = process.env) => {
  if (!selector) throw new Error('缺少账号参数');
  const accounts = readAccounts(env);
  if (/^[0-9]+$/.test(selector)) {
    const index = Number(selector);
    if (index < 1 || index > accounts.length) throw new Error(`账号序号不存在：${selector}`);
    return accounts[index - 1];
  }
  validateName(selector);
  return accounts.find((account) => accountMatches(account, selector)) || null;
};

const currentSlotLabel = (env = process.env) => {
  return decodeAccountLabel(getCodexHome(env));
};

const currentAccount = (env = process.env) => {
  const current = currentSlotLabel(env);
  return readAccounts(env).find((account) => displayAccount(account) === current) || null;
};

const legacyAccountDirs = (env = process.env) => {
  const root = getAccountsRoot(env);
  if (!fs.existsSync(root)) return [];
  assertNotSymlink(root, '拒绝读取符号链接账号目录');
  return fs.readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .map((name) => path.join(root, name))
    .filter((dir) => {
      if (!fs.existsSync(dir)) return false;
      assertNotSymlink(dir, '拒绝读取符号链接账号目录');
      return fs.statSync(dir).isDirectory();
    });
};

const removeLegacyAccountsRoot = (env = process.env) => {
  const root = getAccountsRoot(env);
  if (!fs.existsSync(root)) return false;
  assertNotSymlink(root, '拒绝删除符号链接账号目录');
  fs.rmSync(root, { recursive: true, force: true });
  return true;
};

const importLegacyAccounts = (env = process.env) => {
  const existing = readAccounts(env);
  const imported = [];
  const byId = new Map(existing.map((account) => [account.id, account]));
  const legacyDirs = legacyAccountDirs(env);
  for (const dir of legacyDirs) {
    const auth = readAuth(dir);
    if (!auth) continue;
    const account = normalizeAccount(auth);
    if (byId.has(account.id)) continue;
    imported.push(account);
    byId.set(account.id, account);
  }
  if (imported.length > 0) writeAccounts([...byId.values()], env);
  const removedLegacyRoot = legacyDirs.length > 0 ? removeLegacyAccountsRoot(env) : false;
  return { imported: imported.length, removedLegacyRoot };
};

module.exports = {
  currentAccount,
  currentSlotLabel,
  displayAccount,
  importLegacyAccounts,
  normalizeAccount,
  readAccounts,
  removeAccountEntry,
  resolveAccount,
  upsertAccount,
  validateName,
  writeAccounts,
};
