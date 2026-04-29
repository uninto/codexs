const fs = require('node:fs');
const path = require('node:path');
const { assertNotSymlink } = require('./paths');

const decodeBase64Url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
};

// 读取账号 auth.json 前先校验目录和文件不是符号链接。
const readAuth = (homeDir) => {
  const authPath = path.join(homeDir, 'auth.json');
  if (!fs.existsSync(authPath)) return null;
  assertNotSymlink(homeDir, '拒绝读取符号链接目录');
  assertNotSymlink(authPath, '拒绝读取符号链接文件');
  return JSON.parse(fs.readFileSync(authPath, 'utf8'));
};

const readIdTokenPayloadFromAuth = (auth) => {
  const token = auth && auth.tokens && auth.tokens.id_token;
  if (!token) return null;
  const [, payload] = token.split('.');
  if (!payload) return null;
  return JSON.parse(decodeBase64Url(payload));
};

const decodeAccountEmailFromAuth = (auth) => {
  try {
    const decoded = readIdTokenPayloadFromAuth(auth);
    return decoded && typeof decoded.email === 'string' ? decoded.email : '';
  } catch (_) {
    return '';
  }
};

const decodeShortAccountIdFromAuth = (auth) => {
  try {
    const accountId = auth && auth.tokens && auth.tokens.account_id;
    return typeof accountId === 'string' && accountId.length >= 8 ? accountId.slice(0, 8) : '';
  } catch (_) {
    return '';
  }
};

// 优先展示邮箱；缺少邮箱时退回 account_id 前 8 位。
const decodeAccountLabel = (homeDir) => {
  const auth = readAuth(homeDir);
  return decodeAccountEmailFromAuth(auth) || decodeShortAccountIdFromAuth(auth);
};

module.exports = {
  decodeAccountEmailFromAuth,
  decodeAccountLabel,
  decodeShortAccountIdFromAuth,
  readAuth,
};
