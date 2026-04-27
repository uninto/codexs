const path = require('node:path');
const { readAuth } = require('./auth');

const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 8000;
const USAGE_5H_WINDOW_SECONDS = 18000;
const USAGE_7D_WINDOW_SECONDS = 604800;
const AUTO_SWITCH_MIN_REMAINING_PERCENT = 3;
const QUOTA_COOLING_PERCENT = 100;
const ACCOUNT_USAGE_STATES = Object.freeze({
  AVAILABLE: 'available',
  LIMITED: 'limited',
  COOLING: 'cooling',
  OFFLINE: 'offline',
});

// 从 auth.json 中提取调用 Usage 接口所需的最小凭据；
// 复用 readAuth 的 symlink 防护，保证 list / probe 与 use / init 安全等级一致。
const extractAuthFields = (homeDir) => {
  try {
    const auth = readAuth(homeDir);
    const tokens = auth && auth.tokens;
    if (!tokens || typeof tokens.access_token !== 'string' || typeof tokens.account_id !== 'string') {
      return null;
    }
    return {
      accessToken: tokens.access_token,
      accountId: tokens.account_id,
    };
  } catch (_) {
    return null;
  }
};

const normalizePercent = (value) => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
};

const isValidPercent = (value) => {
  return typeof value === 'number' && value >= 0 && value <= 100;
};

const hasUsageFields = (item) => {
  return Boolean(item && (item.plan || isValidPercent(item.h5_used) || isValidPercent(item.d7_used)));
};

// 将账号目录转换成可并发查询 Usage 的请求条目。
const buildUsageEntries = (accountDirs) => {
  return accountDirs.flatMap((dir) => {
    const fields = extractAuthFields(dir);
    if (!fields) return [];
    return [{
      key: path.basename(dir),
      token: fields.accessToken,
      accountId: fields.accountId,
    }];
  });
};

// 查询单个账号额度；失败时返回结构化 error，避免单账号影响整批结果。
const fetchUsageOne = async (entry, fetchImpl = fetch) => {
  try {
    const response = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${entry.token}`,
        'ChatGPT-Account-Id': entry.accountId,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { key: entry.key, error: response.status };
    const data = await response.json();
    const rateLimit = data.rate_limit || {};
    const windows = [rateLimit.primary_window, rateLimit.secondary_window].filter(Boolean);
    const findWindow = (seconds) => windows.find((window) => window.limit_window_seconds === seconds) || {};
    const h5 = findWindow(USAGE_5H_WINDOW_SECONDS);
    const d7 = findWindow(USAGE_7D_WINDOW_SECONDS);
    return {
      key: entry.key,
      plan: data.plan_type || '',
      h5_used: normalizePercent(h5.used_percent),
      h5_reset: h5.reset_at ?? null,
      d7_used: normalizePercent(d7.used_percent),
      d7_reset: d7.reset_at ?? null,
    };
  } catch (error) {
    return { key: entry.key, error: error.message };
  }
};

// 用 Usage 接口探活账号，避免依赖本地 codex 命令或模型列表输出。
const probeAccountStatus = async (homeDir, fetchImpl = fetch) => {
  const fields = extractAuthFields(homeDir);
  if (!fields) return 'offline';
  if (typeof fetchImpl !== 'function' || typeof AbortSignal.timeout !== 'function') return 'unknown';
  try {
    const response = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${fields.accessToken}`,
        'ChatGPT-Account-Id': fields.accountId,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return 'online';
    if (response.status === 401 || response.status === 403) return 'offline';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
};

const loadUsage = async (accountDirs, fetchImpl = fetch) => {
  if (typeof fetchImpl !== 'function' || typeof AbortSignal.timeout !== 'function') return [];
  const entries = buildUsageEntries(accountDirs);
  if (entries.length === 0) return [];
  return Promise.all(entries.map((entry) => fetchUsageOne(entry, fetchImpl)));
};

const hasUsageData = (results) => {
  return results.some((item) => hasUsageFields(item));
};

const usageFor = (results, key) => {
  return results.find((item) => item.key === key) || null;
};

const usageAvailableForAccount = (results, key) => {
  return hasUsageFields(usageFor(results, key));
};

const classifyPrimaryWindow = (usedPercent) => {
  if (!isValidPercent(usedPercent)) return ACCOUNT_USAGE_STATES.COOLING;
  if (usedPercent >= QUOTA_COOLING_PERCENT) return ACCOUNT_USAGE_STATES.COOLING;
  if (usedPercent >= QUOTA_COOLING_PERCENT - AUTO_SWITCH_MIN_REMAINING_PERCENT) {
    return ACCOUNT_USAGE_STATES.LIMITED;
  }
  return ACCOUNT_USAGE_STATES.AVAILABLE;
};

// 统一账号额度状态，供自动切换和后续展示逻辑复用。
const getAccountUsageState = (item) => {
  if (!hasUsageFields(item)) return ACCOUNT_USAGE_STATES.OFFLINE;
  if (item.plan === 'free') return classifyPrimaryWindow(item.d7_used);
  if (!isValidPercent(item.d7_used) || item.d7_used >= QUOTA_COOLING_PERCENT) {
    return ACCOUNT_USAGE_STATES.COOLING;
  }
  return classifyPrimaryWindow(item.h5_used);
};

const accountShouldAutoSwitch = (results, key) => {
  return [
    ACCOUNT_USAGE_STATES.LIMITED,
    ACCOUNT_USAGE_STATES.COOLING,
    ACCOUNT_USAGE_STATES.OFFLINE,
  ].includes(getAccountUsageState(usageFor(results, key)));
};

const accountIsAvailableForAutoSwitch = (results, key) => {
  return getAccountUsageState(usageFor(results, key)) === ACCOUNT_USAGE_STATES.AVAILABLE;
};

module.exports = {
  ACCOUNT_USAGE_STATES,
  accountIsAvailableForAutoSwitch,
  accountShouldAutoSwitch,
  getAccountUsageState,
  hasUsageData,
  loadUsage,
  probeAccountStatus,
  usageAvailableForAccount,
  usageFor,
};
