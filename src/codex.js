const fs = require('node:fs');
const path = require('node:path');
const { getHomeDir } = require('./paths');

const executableNames = (command) => {
  return process.platform === 'win32'
    ? [`${command}.cmd`, `${command}.exe`, command]
    : [command];
};

// 统一判断候选文件是否可作为命令执行，兼容 Windows 的可执行判断。
const isExecutable = (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (process.platform === 'win32') return fs.statSync(filePath).isFile();
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
};

const archAliases = (arch = process.arch) => {
  const aliases = {
    arm64: ['arm64', 'aarch64'],
    ia32: ['ia32', 'x86'],
    x64: ['x64', 'x86_64'],
  };
  return aliases[arch] || [arch];
};

const platformAliases = (platform = process.platform) => {
  const aliases = {
    darwin: ['darwin', 'macos'],
    linux: ['linux'],
    win32: ['win32', 'windows'],
  };
  return aliases[platform] || [platform];
};

const compatibleVscodePlatformNames = (
  platform = process.platform,
  arch = process.arch,
) => {
  return platformAliases(platform).flatMap((platformName) => {
    return archAliases(arch).map((archName) => `${platformName}-${archName}`);
  });
};

const platformNameFromExtension = (extensionName) => {
  const match = extensionName.match(/^openai\.chatgpt-.+?-(.+-.+)$/);
  return match ? match[1] : '';
};

const orderedVscodePlatformNames = (
  extensionName,
  platform = process.platform,
  arch = process.arch,
) => {
  const compatibleNames = compatibleVscodePlatformNames(platform, arch);
  const parsedName = platformNameFromExtension(extensionName);
  return [
    compatibleNames.includes(parsedName) ? parsedName : '',
    ...compatibleNames,
  ].filter(Boolean);
};

// 按 PATH 顺序查找命令，找到第一个可执行文件即返回。
const findOnPath = (command, env = process.env) => {
  const pathValue = env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    for (const name of executableNames(command)) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return '';
};

// VS Code 插件内也可能自带 codex 二进制，作为 PATH 之外的兜底来源。
const findVscodeCodex = (env = process.env) => {
  const extensionsDir = path.join(getHomeDir(env), '.vscode', 'extensions');
  if (!fs.existsSync(extensionsDir)) return '';
  const extensionNames = fs.readdirSync(extensionsDir).filter((name) => {
    return name.startsWith('openai.chatgpt-');
  });

  for (const extensionName of extensionNames.reverse()) {
    const binDir = path.join(extensionsDir, extensionName, 'bin');
    if (!fs.existsSync(binDir)) continue;
    const candidates = new Set(orderedVscodePlatformNames(extensionName));
    const found = [...candidates]
      .filter((platformName) => fs.existsSync(path.join(binDir, platformName)))
      .flatMap((platformName) =>
        executableNames('codex').map((name) => path.join(binDir, platformName, name)),
      )
      .find(isExecutable);
    if (found) return found;
  }
  return '';
};

const tryFindCodexBin = (env = process.env) => {
  if (env.CODEX_BIN) return isExecutable(env.CODEX_BIN) ? env.CODEX_BIN : '';
  return findOnPath('codex', env) || findVscodeCodex(env);
};

const findCodexBin = (env = process.env) => {
  const codexBin = tryFindCodexBin(env);
  if (!codexBin) {
    throw new Error('找不到 codex。请设置 CODEX_BIN=/path/to/codex，或把 codex 加到 PATH');
  }
  return codexBin;
};

module.exports = {
  __test: {
    compatibleVscodePlatformNames,
    orderedVscodePlatformNames,
    platformNameFromExtension,
  },
  findCodexBin,
};
