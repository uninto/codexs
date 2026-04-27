const fs = require('node:fs');
const path = require('node:path');
const { assertNotSymlink, getAccountsRoot, getCodexHome } = require('./paths');
const { decodeAccountLabel } = require('./auth');

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

const accountHome = (name, env = process.env) => {
  validateName(name);
  return path.join(getAccountsRoot(env), name);
};

// 只返回真实账号目录：跳过隐藏目录，并拒绝读取符号链接目录。
const listAccountDirs = (env = process.env) => {
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
    })
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'en'));
};

const displayAccount = (dir) => {
  return decodeAccountLabel(dir) || path.basename(dir);
};

// 支持序号、账号目录名、显示名三种选择方式，统一解析为账号目录。
const resolveAccountHome = (selector, env = process.env) => {
  if (!selector) throw new Error('缺少账号参数');
  const dirs = listAccountDirs(env);
  if (/^[0-9]+$/.test(selector)) {
    const index = Number(selector);
    if (index < 1 || index > dirs.length) throw new Error(`账号序号不存在：${selector}`);
    return dirs[index - 1];
  }
  const direct = accountHome(selector, env);
  if (fs.existsSync(direct)) return direct;
  return dirs.find((dir) => displayAccount(dir) === selector) || direct;
};

const currentSlotLabel = (env = process.env) => {
  return decodeAccountLabel(getCodexHome(env));
};

// 不启动联网探活，只根据账号目录和 auth.json 做快速状态判断。
const lightStatusLabel = (dir) => {
  if (!fs.existsSync(dir)) return '不存在';
  if (!fs.existsSync(path.join(dir, 'auth.json'))) return '未登录';
  return '已登录';
};

// 通过当前 CODEX_HOME 的账号标签，反查账号仓库里的对应目录。
const currentAccountHome = (env = process.env) => {
  const current = currentSlotLabel(env);
  return listAccountDirs(env).find((dir) => displayAccount(dir) === current) || '';
};

module.exports = {
  accountHome,
  currentAccountHome,
  currentSlotLabel,
  displayAccount,
  lightStatusLabel,
  listAccountDirs,
  resolveAccountHome,
  validateName,
};
