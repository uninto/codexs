const readline = require('node:readline/promises');

const INDEX_WIDTH = 4;
const PLAN_WIDTH = 8;
const USAGE_WIDTH = 14;
const STATUS_WIDTH = 10;
const PROGRESS_INTERVAL_MS = 120;
const PROGRESS_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const pad = (value, width) => {
  return String(value).padEnd(width, ' ');
};

const colorize = (value, color, env = process.env, stream = process.stdout) => {
  if (!stream.isTTY || env.NO_COLOR) return value;
  const colors = {
    green: 32,
    lightGray: '38;2;230;230;230',
    lightRed: '38;2;255;160;160',
    lightYellow: '38;2;255;230;150',
  };
  return `\u001b[${colors[color]}m${value}\u001b[0m`;
};

const bold = (value, env = process.env, stream = process.stdout) => {
  if (!stream.isTTY || env.NO_COLOR) return value;
  return `\u001b[1m${value}\u001b[0m`;
};

const formatPlanType = (plan) => {
  const names = {
    free: 'Free',
    plus: 'Plus',
    prolite: 'ProLite',
    pro: 'Pro',
    team: 'Team',
    business: 'Biz',
    enterprise: 'Ent',
    edu: 'Edu',
  };
  return names[plan] || plan || '-';
};

const formatUsagePercent = (used) => {
  if (typeof used !== 'number' || used < 0 || used > 100) return '-';
  return `${Math.round(100 - used)}%`;
};

const formatResetTime = (resetAt, mode = 'time') => {
  if (typeof resetAt !== 'number') return '';
  const now = Math.floor(Date.now() / 1000);
  if (resetAt - now <= 0) return '已重置';
  const date = new Date(resetAt * 1000);
  if (mode === 'date') {
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const formatListIndex = (index, isCurrent) => {
  return isCurrent ? `${index}*` : String(index);
};

// 删除离线账号必须由交互终端确认，避免脚本环境误删。
const confirmRemoval = async (
  account,
  input = process.stdin,
  output = process.stdout,
) => {
  if (!input.isTTY) throw new Error('删除离线账号需要交互式终端确认');
  output.write(`检测到离线账号：${account}\n`);
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question('是否删除？1：确定 2：取消\n');
  rl.close();
  if (answer === '1') return true;
  if (answer === '2') {
    output.write(`已取消删除离线账号：${account}\n`);
  } else {
    output.write(`输入无效，已取消删除离线账号：${account}\n`);
  }
  return false;
};

const printRow = (
  row,
  { isCurrent = false, color = '' } = {},
  output = process.stdout,
) => {
  if (isCurrent) {
    const starIndex = row.indexOf('*');
    if (starIndex !== -1) {
      const before = row.slice(0, starIndex);
      const after = row.slice(starIndex + 1);
      const paint = (value) => (color ? colorize(value, color, process.env, output) : value);
      output.write(`${paint(before)}${colorize('*', 'green', process.env, output)}${paint(after)}\n`);
      return;
    }
  }
  output.write(`${color ? colorize(row, color, process.env, output) : row}\n`);
};

const shouldShowProgress = (env = process.env, stream = process.stderr) => {
  const value = env.CX_PROGRESS || 'auto';
  if (['1', 'always', 'true'].includes(value)) return true;
  if (['0', 'never', 'false'].includes(value)) return false;
  return Boolean(stream.isTTY);
};

// 在 stderr 渲染可关闭的进度动画，stdout 保持给机器可读输出。
const startProgress = (message, env = process.env, stream = process.stderr) => {
  if (!shouldShowProgress(env, stream)) return () => {};

  let index = 0;
  const writeFrame = () => {
    stream.write(`\r\u001b[K${PROGRESS_FRAMES[index]} ${message}`);
    index = (index + 1) % PROGRESS_FRAMES.length;
  };
  writeFrame();
  const timer = setInterval(writeFrame, PROGRESS_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    stream.write('\r\u001b[K');
  };
};

const withProgress = async (
  message,
  action,
  env = process.env,
  stream = process.stderr,
) => {
  const stop = startProgress(message, env, stream);
  try {
    return await action();
  } finally {
    stop();
  }
};

module.exports = {
  INDEX_WIDTH,
  PLAN_WIDTH,
  STATUS_WIDTH,
  USAGE_WIDTH,
  bold,
  colorize,
  confirmRemoval,
  formatListIndex,
  formatPlanType,
  formatResetTime,
  formatUsagePercent,
  pad,
  printRow,
  withProgress,
};
