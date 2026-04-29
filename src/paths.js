const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Git Bash / MSYS 上 HOME 可能是 `/c/Users/x`，与 path.win32 不兼容；
// 转换成 `C:\Users\x` 让后续 path.join 在 Windows 上稳定工作。
const normalizeWindowsHome = (value) => {
  if (!value) return value;
  const msys = value.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (msys) return `${msys[1].toUpperCase()}:${(msys[2] || '').replace(/\//g, '\\')}`;
  return value;
};

const getHomeDir = (env = process.env) => {
  if (process.platform === 'win32') {
    const profile = env.USERPROFILE
      || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : '')
      || normalizeWindowsHome(env.HOME)
      || os.homedir();
    return profile;
  }
  return env.HOME || os.homedir();
};

const getAccountsRoot = (env = process.env) => {
  return env.CODEX_ACCOUNTS_ROOT || path.join(getHomeDir(env), '.codex-accounts');
};

const getCodexHome = (env = process.env) => {
  return path.join(getHomeDir(env), '.codex');
};

const getAccountsFile = (env = process.env) => {
  return path.join(getCodexHome(env), 'codex-accounts.json');
};

// 所有账号和 auth 文件操作前都拒绝符号链接，避免越界读写。
const assertNotSymlink = (targetPath, message) => {
  if (!fs.existsSync(targetPath)) return;
  if (fs.lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`${message}：${targetPath}`);
  }
};

const ensureReadableFile = (filePath) => {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`文件不存在：${filePath}`);
  }
  assertNotSymlink(filePath, '拒绝读取符号链接文件');
  fs.accessSync(filePath, fs.constants.R_OK);
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  assertNotSymlink(dirPath, '拒绝写入符号链接目录');
  try { fs.chmodSync(dirPath, 0o700); } catch (_) {}
};

// 先写唯一临时文件再 rename，避免 auth.json 出现半写入状态或并发冲突。
const writeFileAtomically = (targetPath, data) => {
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`目标目录不存在：${targetDir}`);
  }
  assertNotSymlink(targetDir, '拒绝写入符号链接目录');
  assertNotSymlink(targetPath, '拒绝覆盖符号链接文件');

  const tempPath = path.join(
    targetDir,
    `.${path.basename(targetPath)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`,
  );
  let cleanupTemp = true;
  try {
    // wx：独占创建，避免命中已有文件或符号链接。
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, data);
      try { fs.fsyncSync(fd); } catch (_) {}
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(tempPath, 0o600); } catch (_) { /* Windows 忽略 */ }
    fs.renameSync(tempPath, targetPath);
    cleanupTemp = false;
  } finally {
    if (cleanupTemp) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
};

module.exports = {
  assertNotSymlink,
  ensureDir,
  ensureReadableFile,
  getAccountsFile,
  getAccountsRoot,
  getCodexHome,
  getHomeDir,
  writeFileAtomically,
};
