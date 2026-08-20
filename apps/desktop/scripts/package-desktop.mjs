import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(desktopRoot, "../..");
const webDist = join(projectRoot, "apps", "web", "dist");
const apiWorkspaceModules = join(projectRoot, "apps", "api", "node_modules");
const electronPackage = require.resolve("electron");
const electronDirectory = dirname(electronPackage);
const electronDist = join(electronDirectory, "dist");
const electronVersion = require(
  join(electronDirectory, "package.json"),
).version;
const productName = "ZhihuArticleToVideo";
const displayName = "知乎文章转视频";
const stageRoot = join(desktopRoot, ".stage");
const apiDeployment = join(stageRoot, "api");
const run = promisify(execFile);

// 应用图标资源（由 scripts/build-icons.mjs 从 icon.png 生成 ico/icns）。
const resourcesDirectory = join(desktopRoot, "resources");
const iconIco = join(resourcesDirectory, "icon.ico");
const iconIcns = join(resourcesDirectory, "icon.icns");
// 安装包版本号：沿用桌面包 package.json 的 version，构建号由 CI 注入。
const appVersion = require(join(desktopRoot, "package.json")).version;

/**
 * npm 上最新的 better-sqlite3 12.11.1 尚未发布 Electron 43（ABI 148）的
 * 预编译二进制，12.12.0 起官方才开始提供。已实测 12.11.1 的 JS 层与
 * 12.12.0 的原生模块接口兼容，交叉打包时借用 12.12.0 的预编译产物；
 * 与宿主同平台打包时仍使用 electron-rebuild 按源码重建的版本。
 */
const SQLITE_PREBUILD_RELEASE = "12.12.0";

/**
 * 内置 Playwright Chromium：目标机器没有 Chrome/Edge 时由应用自带浏览器
 * 保底（browser-resolver 探测链的最后一环）。版本随 api 依赖的
 * playwright-core（browsers.json 修订号），下载产物缓存在
 * .stage/playwright-browsers，重复打包不重复下载。
 * Playwright 1.49+ 的 chromium 实为 Chrome for Testing，交叉打包时
 * 必须按 browsers.json 的 browserVersion 下载对应平台产物。
 */
const PLAYWRIGHT_DOWNLOAD_HOST =
  process.env.PLAYWRIGHT_DOWNLOAD_HOST ?? "https://cdn.playwright.dev";

// 交叉打包直下载时各目标在 Chrome for Testing CDN 的相对路径。
const CHROMIUM_ARCHIVE_PATH = {
  "win32-x64": "win64/chrome-win64.zip",
  "darwin-x64": "mac-x64/chrome-mac-x64.zip",
  "darwin-arm64": "mac-arm64/chrome-mac-arm64.zip",
  "linux-x64": "linux64/chrome-linux64.zip",
};

/**
 * 内置 FFmpeg 静态构建：用户无需自行安装 FFmpeg。
 * Windows 使用 BtbN 的 GPL 构建（开箱即用、codec 全、无外部依赖）。
 * 下载产物缓存在 .stage/ffmpeg，重复打包不重复下载。
 */
const FFMPEG_RELEASE_BASE =
  process.env.FFMPEG_DOWNLOAD_BASE ??
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";

/**
 * BtbN 只发布 Windows/Linux 构建，macOS 改用 eugeneware/ffmpeg-static
 * 的官方静态二进制（裸可执行文件，下载后无需解压，b6.0 = FFmpeg 6.0）。
 */
const FFMPEG_DARWIN_RELEASE =
  process.env.FFMPEG_DARWIN_DOWNLOAD_BASE ??
  "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0";

const FFMPEG_ARCHIVE_NAME = {
  "win32-x64": "ffmpeg-master-latest-win64-gpl.zip",
};

/** 解压后 ffmpeg 二进制在压缩包内的相对路径（BtbN 包带顶层目录）。 */
const FFMPEG_BINARY_IN_ARCHIVE = {
  "win32-x64": "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe",
};

function argValue(name) {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const targetPlatform = argValue("--platform") ?? process.platform;
const targetArch = argValue("--arch") ?? process.arch;
const skipBrowser =
  process.argv.includes("--skip-browser") ||
  process.env.SKIP_BROWSER_BUNDLE === "1";
const skipFfmpeg =
  process.argv.includes("--skip-ffmpeg") ||
  process.env.SKIP_FFMPEG_BUNDLE === "1";

if (process.platform !== "darwin" && process.platform !== "win32") {
  throw new Error("只支持在 macOS 或 Windows 构建桌面应用。");
}
if (targetPlatform !== "darwin" && targetPlatform !== "win32") {
  throw new Error(`不支持的目标平台：${targetPlatform}`);
}
if (targetPlatform === "darwin" && process.platform !== "darwin") {
  throw new Error("macOS 应用只能在 macOS 上构建。");
}
if (targetPlatform !== process.platform && targetArch !== "x64") {
  throw new Error("交叉打包仅支持 win32-x64 目标。");
}

const outputRoot = join(desktopRoot, "out", targetPlatform);

await rm(outputRoot, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 200,
});
await rm(apiDeployment, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await deployApi();
await cleanStagedApi();
await patchPipelineExports();
await prepareNativeModules();

if (targetPlatform === "darwin") {
  const targetApp = join(outputRoot, `${productName}.app`);
  // Electron.app 的 Framework 目录依赖相对符号链接，必须原样保留，
  // 否则拷贝后的包缺少 icudtl.dat 等资源而无法启动。
  await cp(join(electronDist, "Electron.app"), targetApp, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await patchInfoPlist(targetApp);
  await addApplicationResources(
    join(targetApp, "Contents", "Resources", "app"),
  );
  await assertMacOSIcon(targetApp);
  await verifyMacOSBundle(targetApp);
  await createMacOSDmg(targetApp);
  console.log(`已生成 macOS 应用：${targetApp}`);
} else {
  const winDist = await ensureElectronDist("win32", targetArch);
  const targetDirectory = join(outputRoot, productName);
  await cp(winDist, targetDirectory, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await rename(
    join(targetDirectory, "electron.exe"),
    join(targetDirectory, `${productName}.exe`),
  );
  await addApplicationResources(join(targetDirectory, "resources", "app"));
  await embedWindowsIcon(targetDirectory);
  await reportWindowsBinaries(targetDirectory);
  if (process.platform === "win32") {
    // exe 与安装器只能在 Windows 上运行校验；macOS 交叉打包仅产出便携 zip。
    await verifyWindowsBundle(targetDirectory);
    const installerPath = await buildWindowsInstaller(targetDirectory);
    if (installerPath) {
      try {
        await verifyWindowsInstaller(installerPath);
      } catch (verifyError) {
        console.warn(
          `安装器静默校验跳过（可能需要管理员权限）：${verifyError.message}`,
        );
      }
    }
  } else {
    console.warn(
      "交叉打包：跳过 Windows 模块加载校验与 NSIS 安装器（需在 Windows 原生构建）。",
    );
  }
  await archiveWindowsOutput(targetDirectory);
}

/** pnpm deploy 偶发 EPERM，重试几次即可恢复。 */
async function deployApi() {
  const args = [
    "--filter",
    "@zhihu-video/api",
    "deploy",
    apiDeployment,
    "--prod",
    "--legacy",
    // hoisted 布局产出无符号链接的扁平 node_modules，
    // 拷贝到应用包后在 Windows 上也能直接运行。
    "--config.node-linker=hoisted",
  ];
  // 不再经 corepack 调用：Windows 上 corepack 只有 .cmd shim，execFile 不经
  // shell 无法执行（spawn corepack ENOENT）。直接调用工作区已安装的 pnpm——
  // CI 由 pnpm/action-setup 提供独立 pnpm.exe，本地多为 pnpm.cmd；Windows 下
  // 借助 shell 让 cmd.exe 按 PATHEXT 解析可执行文件，两种安装都能命中。
  const options = {
    cwd: projectRoot,
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === "win32",
  };
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await run("pnpm", args, options);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`API 部署失败，正在重试（${attempt}/3）…`);
      await rm(apiDeployment, { recursive: true, force: true });
    }
  }
  throw lastError;
}

/** 移除随 deploy 一并拷贝的开发期产物，避免泄露本地数据并减小体积。 */
async function cleanStagedApi() {
  const junk = [
    "data",
    "outputs",
    "test",
    "src",
    "eslint.config.mjs",
    "vitest.config.ts",
    "tsconfig.json",
    "README.md",
  ];
  await Promise.all(
    junk.map((entry) =>
      rm(join(apiDeployment, entry), { recursive: true, force: true }),
    ),
  );
}

/**
 * 生产环境的 Node 无法加载 node_modules 内的 TypeScript 源码，
 * 将部署副本的入口改指到已编译的 dist 产物。
 */
async function patchPipelineExports() {
  const manifestPath = join(
    apiDeployment,
    "node_modules",
    "@zhihu-video",
    "pipeline",
    "package.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports = { ".": "./dist/index.js" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function prepareNativeModules() {
  const stagedSqlite = join(apiDeployment, "node_modules", "better-sqlite3");
  // better-sqlite3 13+ 随包分发全平台 N-API 预编译（prebuilds/<platform>-<arch>.node，
  // 同一二进制在 Node 与 Electron 下通用），deploy 副本自带目标平台产物，
  // 无需 electron-rebuild 覆盖或下载 Electron ABI 预编译。
  if (
    existsSync(
      join(stagedSqlite, "prebuilds", `${targetPlatform}-${targetArch}.node`),
    )
  ) {
    console.log(
      `复用 better-sqlite3 内置 N-API 预编译（${targetPlatform}-${targetArch}）。`,
    );
    if (targetPlatform !== process.platform) {
      await replaceSharpPrebuilds();
    }
    return;
  }
  if (targetPlatform === process.platform) {
    // 与宿主同平台：rebuild-native 已按 Electron ABI 重建工作区副本，
    // deploy 从内容寻址仓库克隆的仍是 Node ABI 二进制，需要覆盖。
    const rebuilt = join(
      apiWorkspaceModules,
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    await cp(
      rebuilt,
      join(stagedSqlite, "build", "Release", "better_sqlite3.node"),
    );
    return;
  }
  // 交叉打包：下载目标平台 Electron ABI 的预编译二进制。
  const nodeAbi = require(join(apiDeployment, "node_modules", "node-abi"));
  const abi = nodeAbi.getAbi(electronVersion, "electron");
  const prebuildUrl =
    `https://github.com/WiseLibs/better-sqlite3/releases/download/` +
    `v${SQLITE_PREBUILD_RELEASE}/` +
    `better-sqlite3-v${SQLITE_PREBUILD_RELEASE}-electron-v${abi}-` +
    `${targetPlatform}-${targetArch}.tar.gz`;
  console.log(`下载 better-sqlite3 预编译二进制（Electron ABI ${abi}）…`);
  const tarballPath = join(
    stageRoot,
    `better-sqlite3-electron-v${abi}-${targetPlatform}-${targetArch}.tar.gz`,
  );
  const response = await fetch(prebuildUrl);
  if (!response.ok) {
    throw new Error(
      `下载 better-sqlite3 预编译二进制失败（${response.status}）：${prebuildUrl}`,
    );
  }
  await writeFile(tarballPath, Buffer.from(await response.arrayBuffer()));
  await run("tar", ["-xzf", tarballPath, "-C", stagedSqlite]);
  await rm(tarballPath, { force: true });
  await replaceSharpPrebuilds();
}

/** 用目标平台的 sharp 预编译包替换宿主平台产物。 */
async function replaceSharpPrebuilds() {
  const imgDirectory = join(apiDeployment, "node_modules", "@img");
  const sharpManifest = JSON.parse(
    await readFile(
      join(apiDeployment, "node_modules", "sharp", "package.json"),
      "utf8",
    ),
  );
  const packageName = `sharp-${targetPlatform}-${targetArch}`;
  const tarballUrl =
    `https://registry.npmjs.org/@img/${packageName}/-/` +
    `${packageName}-${sharpManifest.version}.tgz`;
  const tarballPath = join(stageRoot, `${packageName}.tgz`);
  console.log(`下载 @img/${packageName}@${sharpManifest.version}…`);
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(
      `下载 sharp 预编译包失败（${response.status}）：${tarballUrl}`,
    );
  }
  await writeFile(tarballPath, Buffer.from(await response.arrayBuffer()));
  const targetDirectory = join(imgDirectory, packageName);
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  await run("tar", [
    "-xzf",
    tarballPath,
    "-C",
    targetDirectory,
    "--strip-components",
    "1",
  ]);
  await rm(tarballPath, { force: true });
  for (const entry of await readdir(imgDirectory)) {
    if (entry !== packageName && entry.startsWith("sharp-")) {
      await rm(join(imgDirectory, entry), { recursive: true, force: true });
    }
  }
}

/** 下载并解压目标平台的 Electron 官方预构建运行时（带本地缓存）。 */
async function ensureElectronDist(platform, arch) {
  const cacheDirectory = join(stageRoot, `electron-${platform}-${arch}`);
  const marker = join(
    cacheDirectory,
    platform === "win32" ? "electron.exe" : "Electron.app",
  );
  if (existsSync(marker)) {
    console.log(`复用已缓存的 Electron ${platform}-${arch} 运行时。`);
    return cacheDirectory;
  }
  const { downloadArtifact } = require(
    require.resolve("@electron/get", { paths: [electronDirectory] }),
  );
  const { extract } = require(
    require.resolve("@electron-internal/extract-zip", {
      paths: [electronDirectory],
    }),
  );
  console.log(
    `下载 Electron ${electronVersion} 的 ${platform}-${arch} 运行时…`,
  );
  // Node 24 可能不会为下载器的网络请求保持事件循环，这里手动保活。
  const keepAlive = setInterval(() => undefined, 1_000);
  let archive;
  try {
    archive = await downloadArtifact({
      version: electronVersion,
      artifactName: "electron",
      platform,
      arch,
      checksums: require(join(electronDirectory, "checksums.json")),
    });
  } finally {
    clearInterval(keepAlive);
  }
  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(cacheDirectory, { recursive: true });
  await extract(archive, { dir: cacheDirectory });
  if (!existsSync(marker)) {
    throw new Error("Electron 运行时解压后缺少主程序。");
  }
  return cacheDirectory;
}

/** PlistBuddy 先尝试 Set，键不存在时退回 Add。 */
async function setPlistValue(plist, key, value) {
  try {
    await run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  } catch {
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      `Add :${key} string ${value}`,
      plist,
    ]);
  }
}

/** 修正 macOS 应用包的显示名称与图标（菜单栏、Finder 与程序坞展示）。 */
async function patchInfoPlist(targetApp) {
  const plist = join(targetApp, "Contents", "Info.plist");
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    await setPlistValue(plist, key, displayName);
  }
  if (existsSync(iconIcns)) {
    // 拷入自定义图标并让 Info.plist 指向它（值不含 .icns 扩展名）。
    await cp(iconIcns, join(targetApp, "Contents", "Resources", "AppIcon.icns"));
    await setPlistValue(plist, "CFBundleIconFile", "AppIcon");
    await setPlistValue(plist, "CFBundleIconName", "AppIcon");
  } else {
    console.warn("缺少 resources/icon.icns，macOS 应用沿用 Electron 默认图标。");
  }
}

/** 断言 macOS 应用包已正确携带自定义图标。 */
async function assertMacOSIcon(targetApp) {
  const iconPath = join(targetApp, "Contents", "Resources", "AppIcon.icns");
  if (!existsSync(iconPath)) {
    throw new Error("macOS 应用包缺少 AppIcon.icns。");
  }
  const plist = join(targetApp, "Contents", "Info.plist");
  const { stdout } = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIconFile",
    plist,
  ]);
  if (!stdout.trim().includes("AppIcon")) {
    throw new Error("macOS Info.plist 未正确设置 CFBundleIconFile。");
  }
  console.log("macOS 应用图标校验通过。");
}

/** 用系统自带 hdiutil 由 .app 生成只读 DMG 分发镜像。 */
async function createMacOSDmg(targetApp) {
  const dmgPath = join(outputRoot, `${productName}-macos-${targetArch}.dmg`);
  await rm(dmgPath, { force: true });
  await run(
    "hdiutil",
    [
      "create",
      "-volname",
      displayName,
      "-srcfolder",
      targetApp,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (!existsSync(dmgPath)) {
    throw new Error("DMG 生成后未找到产物。");
  }
  console.log(`已生成 macOS 磁盘映像：${dmgPath}`);
  return dmgPath;
}

/**
 * 用打包后的二进制以 Node 模式加载应用内的原生模块与工作区包，
 * 在打包阶段暴露 ABI 不匹配或入口解析失败。macOS 与 Windows 共用。
 */
async function runModuleLoadCheck(binary, appDirectory) {
  const databasePath = join(stageRoot, "verify.sqlite");
  const script = `
    import(${JSON.stringify(pathToFileURL(join(appDirectory, "api", "dist", "src", "app.js")).href)})
      .then((m) => {
        const app = m.buildApp({
          databasePath: ${JSON.stringify(databasePath)},
          outputDirectory: ${JSON.stringify(join(stageRoot, "verify-outputs"))},
          logger: false,
        });
        return app.close();
      })
      .then(() => console.log("PACKAGED MODULES OK"))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  `;
  await run(binary, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    maxBuffer: 8 * 1024 * 1024,
  });
  await rm(databasePath, { force: true });
  await rm(join(stageRoot, "verify-outputs"), { recursive: true, force: true });
}

async function verifyMacOSBundle(targetApp) {
  const binary = join(targetApp, "Contents", "MacOS", "Electron");
  const appDirectory = join(targetApp, "Contents", "Resources", "app");
  await runModuleLoadCheck(binary, appDirectory);
  console.log("macOS 应用内模块加载校验通过。");
}

/** Windows 主程序以 Node 模式加载应用模块，校验 better-sqlite3 ABI 与入口解析。 */
async function verifyWindowsBundle(targetDirectory) {
  const binary = join(targetDirectory, `${productName}.exe`);
  const appDirectory = join(targetDirectory, "resources", "app");
  await runModuleLoadCheck(binary, appDirectory);
  console.log("Windows 应用内模块加载校验通过。");
}

/**
 * 用 rcedit 将 icon.ico 与版本信息嵌入 Windows 主程序。
 * macOS 交叉打包缺少 wine 时无法运行 rcedit，告警并保留默认图标，不致构建失败。
 */
async function embedWindowsIcon(targetDirectory) {
  if (!existsSync(iconIco)) {
    console.warn("缺少 resources/icon.ico，跳过 Windows 图标嵌入。");
    return;
  }
  const exePath = join(targetDirectory, `${productName}.exe`);
  try {
    const { rcedit } = await import("rcedit");
    await rcedit(exePath, {
      icon: iconIco,
      "file-version": `${appVersion}.0`,
      "product-version": `${appVersion}.0`,
      "version-string": {
        ProductName: displayName,
        FileDescription: displayName,
        CompanyName: productName,
        OriginalFilename: `${productName}.exe`,
        LegalCopyright: `Copyright (c) ${productName}`,
      },
    });
    console.log("已为 Windows 主程序嵌入图标与版本信息。");
  } catch (error) {
    console.warn(
      `Windows 图标嵌入失败（交叉打包可能缺少 wine）：${error.message}`,
    );
  }
}

/** makensis 是否在 PATH 中可用（windows-latest Runner 已预装 NSIS）。 */
async function findMakensis() {
  try {
    await run("makensis", ["-VERSION"], { maxBuffer: 1024 * 1024 });
    return "makensis";
  } catch {
    // PATH 中没有时，探测常见安装位置（NSIS 默认装于 Program Files (x86)，
    // 安装程序不会自动将其加入 PATH）。
    const candidates = [
      join(
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        "NSIS",
        "makensis.exe",
      ),
      join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "NSIS",
        "makensis.exe",
      ),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}

/** 调用 makensis 由应用目录生成 NSIS 安装器；缺工具时返回 null（仍产出便携 zip）。 */
async function buildWindowsInstaller(targetDirectory) {
  const makensis = await findMakensis();
  if (!makensis) {
    console.warn("未找到 makensis，跳过 NSIS 安装器生成（仍产出便携 zip）。");
    return null;
  }
  const installerPath = join(
    outputRoot,
    `${productName}-${targetPlatform}-${targetArch}-Setup.exe`,
  );
  await rm(installerPath, { force: true });
  await run(
    makensis,
    [
      `/DVERSION=${appVersion}`,
      `/DSRC=${targetDirectory}`,
      `/DOUT_FILE=${installerPath}`,
      `/DICON=${iconIco}`,
      `/DEXE_NAME=${productName}.exe`,
      join(desktopRoot, "scripts", "installer.nsi"),
    ],
    { cwd: desktopRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  if (!existsSync(installerPath)) {
    throw new Error("NSIS 安装器生成后未找到产物。");
  }
  console.log(`已生成 Windows 安装器：${installerPath}`);
  return installerPath;
}

/**
 * NSIS 安装器冒烟：静默安装到临时目录 → 用已安装主程序做模块加载校验 →
 * 静默卸载清理。覆盖“安装无错误 + 启动正常 + 功能基线”。
 */
async function verifyWindowsInstaller(installerPath) {
  const installDirectory = join(stageRoot, "verify-install");
  await rm(installDirectory, { recursive: true, force: true });
  // NSIS 静默安装：/S 配合 /D 指定目录，/D 必须置末且不带引号。
  await run(installerPath, ["/S", `/D=${installDirectory}`], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const installedExe = join(installDirectory, `${productName}.exe`);
  if (!existsSync(installedExe)) {
    throw new Error("NSIS 静默安装后未找到主程序。");
  }
  await verifyWindowsBundle(installDirectory);
  const uninstaller = join(installDirectory, "Uninstall.exe");
  if (existsSync(uninstaller)) {
    // _?= 使卸载器同步就地运行（不拷到临时目录），便于随后清理。
    await run(uninstaller, ["/S", `_?=${installDirectory}`], {
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  await rm(installDirectory, { recursive: true, force: true });
  console.log("Windows 安装器静默安装/卸载校验通过。");
}

/** 打印 Windows 关键二进制格式，确认交叉替换产物正确。 */
async function reportWindowsBinaries(targetDirectory) {
  if (process.platform !== "darwin") return;
  const sharpLibDirectory = join(
    targetDirectory,
    "resources",
    "app",
    "api",
    "node_modules",
    "@img",
    `sharp-${targetPlatform}-${targetArch}`,
    "lib",
  );
  const sharpBinaries = await readdir(sharpLibDirectory);
  const binaries = [
    join(targetDirectory, `${productName}.exe`),
    join(
      targetDirectory,
      "resources",
      "app",
      "api",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ),
    ...sharpBinaries
      .filter((entry) => entry.endsWith(".node"))
      .map((entry) => join(sharpLibDirectory, entry)),
  ];
  for (const binary of binaries) {
    const { stdout } = await run("file", [binary]);
    console.log(`  ${stdout.trim()}`);
  }
}

/** 生成便于拷贝分发的 zip 压缩包。 */
async function archiveWindowsOutput(targetDirectory) {
  const zipPath = join(
    outputRoot,
    `${productName}-${targetPlatform}-${targetArch}.zip`,
  );
  await rm(zipPath, { force: true });
  if (process.platform === "darwin") {
    await run("ditto", ["-c", "-k", "--keepParent", targetDirectory, zipPath]);
  } else {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -LiteralPath '${targetDirectory}' -DestinationPath '${zipPath}'`,
    ]);
  }
  console.log(`已生成 Windows 应用目录：${targetDirectory}`);
  console.log(`已生成 Windows 压缩包：${zipPath}`);
}

async function addApplicationResources(applicationDirectory) {
  await mkdir(applicationDirectory, { recursive: true });
  await cp(join(desktopRoot, "dist"), applicationDirectory, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await cp(webDist, join(applicationDirectory, "web"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await cp(apiDeployment, join(applicationDirectory, "api"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  if (!skipBrowser) {
    await bundlePlaywrightBrowser(applicationDirectory);
  } else {
    console.log("跳过内置 Chromium（--skip-browser），运行时将使用本机浏览器。");
  }
  if (!skipFfmpeg) {
    await bundleFfmpeg(applicationDirectory);
  } else {
    console.log("跳过内置 FFmpeg（--skip-ffmpeg），运行时将使用系统 PATH。");
  }
  await writeFile(
    join(applicationDirectory, "package.json"),
    JSON.stringify(
      {
        name: "zhihu-article-to-video",
        main: "main.js",
        type: "module",
        private: true,
      },
      null,
      2,
    ),
  );
}

/** 从部署副本的 playwright-core 读取 Chromium 修订号（含平台覆盖）。 */
async function chromiumRevision() {
  const browsersJsonPath = join(
    apiDeployment,
    "node_modules",
    "playwright-core",
    "browsers.json",
  );
  const { browsers } = JSON.parse(await readFile(browsersJsonPath, "utf8"));
  const chromium = browsers.find((entry) => entry.name === "chromium");
  if (!chromium) {
    throw new Error("playwright-core browsers.json 中缺少 chromium 定义。");
  }
  const overrides = chromium.revisionOverrides ?? {};
  if (!chromium.browserVersion) {
    throw new Error("playwright-core browsers.json 中缺少 chromium browserVersion。");
  }
  return {
    revision:
      overrides[`${targetPlatform}-${targetArch}`] ??
      overrides[targetPlatform] ??
      chromium.revision,
    browserVersion: chromium.browserVersion,
  };
}

/**
 * 准备目标平台的 Chromium 浏览器目录（带本地缓存）。
 * 返回浏览器目录与清单用的相对可执行路径。
 */
async function ensurePlaywrightChromium() {
  const { revision, browserVersion } = await chromiumRevision();
  const browserDirectoryName = `chromium-${revision}`;
  const cacheDirectory = join(
    stageRoot,
    "playwright-browsers",
    `${targetPlatform}-${targetArch}`,
  );
  const browserDirectory = join(cacheDirectory, browserDirectoryName);
  // CLI 安装成功后会写入 INSTALLATION_COMPLETE 标记；直下载路径由我们补写。
  const completionMarker = join(browserDirectory, "INSTALLATION_COMPLETE");
  if (existsSync(completionMarker)) {
    console.log(
      `复用已缓存的 Playwright Chromium（${targetPlatform}-${targetArch}）。`,
    );
  } else {
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(browserDirectory, { recursive: true });
    if (targetPlatform === process.platform && targetArch === process.arch) {
      await installChromiumViaPlaywrightCli(cacheDirectory);
    } else {
      await downloadChromiumArchive(browserVersion, browserDirectory);
      await writeFile(completionMarker, "");
    }
  }
  const executablePath = await findChromiumExecutable(browserDirectory);
  const executableRelativePath =
    `${browserDirectoryName}/` +
    relative(browserDirectory, executablePath).split(sep).join("/");
  return { browserDirectory, browserDirectoryName, executableRelativePath };
}

/**
 * 在浏览器目录内定位可执行文件。Playwright 1.49+ 的 chromium 实为
 * Chrome for Testing，目录名随平台与架构变化（chrome-win、chrome-mac、
 * chrome-mac-arm64…），硬编码相对路径极易随版本失效，改为按形态扫描：
 * Windows/Linux 找一级子目录下的 chrome(.exe)，macOS 找 .app 内二进制。
 */
async function findChromiumExecutable(browserDirectory) {
  const candidates = [];
  for (const entry of await readdir(browserDirectory)) {
    const subdirectory = join(browserDirectory, entry);
    if (targetPlatform === "win32") {
      candidates.push(join(subdirectory, "chrome.exe"));
    } else if (targetPlatform === "linux") {
      candidates.push(join(subdirectory, "chrome"));
    } else {
      let appEntries = [];
      try {
        appEntries = await readdir(subdirectory);
      } catch {
        continue; // 文件而非目录，跳过。
      }
      for (const appEntry of appEntries) {
        if (!appEntry.endsWith(".app")) continue;
        const macosDirectory = join(
          subdirectory,
          appEntry,
          "Contents",
          "MacOS",
        );
        try {
          for (const binary of await readdir(macosDirectory)) {
            candidates.push(join(macosDirectory, binary));
          }
        } catch {
          // 无 Contents/MacOS 的目录不是浏览器主体，忽略。
        }
      }
    }
  }
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(`无法在 ${browserDirectory} 内定位 Chromium 可执行文件。`);
  }
  return executable;
}

/** 同平台构建：调用部署副本的 playwright-core CLI 下载并解压。 */
async function installChromiumViaPlaywrightCli(browsersPath) {
  const cliPath = join(
    apiDeployment,
    "node_modules",
    "playwright-core",
    "cli.js",
  );
  console.log("下载 Playwright Chromium（首次较慢，之后复用本地缓存）…");
  // --no-shell：reader 无头与可见模式都走同一个完整 Chromium，
  // 无需再下载 chromium-headless-shell（省约 100MB）。
  await run(
    process.execPath,
    [cliPath, "install", "chromium", "--no-shell"],
    {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

/** 交叉打包（macOS → Windows）：直接拉取 Playwright CDN 压缩包解压。 */
async function downloadChromiumArchive(browserVersion, targetDirectory) {
  const archivePath = CHROMIUM_ARCHIVE_PATH[`${targetPlatform}-${targetArch}`];
  if (!archivePath) {
    throw new Error(
      `缺少 ${targetPlatform}-${targetArch} 的 Chromium 压缩包映射。`,
    );
  }
  const url = `${PLAYWRIGHT_DOWNLOAD_HOST}/builds/cft/${browserVersion}/${archivePath}`;
  const archiveFile = join(stageRoot, archivePath.split("/").at(-1));
  console.log(`下载 Chrome for Testing ${browserVersion}（${archivePath}）…`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载 Chromium 失败（${response.status}）：${url}`);
  }
  await writeFile(archiveFile, Buffer.from(await response.arrayBuffer()));
  if (process.platform === "darwin") {
    await run("ditto", ["-x", "-k", archiveFile, targetDirectory]);
  } else {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archiveFile}' -DestinationPath '${targetDirectory}'`,
    ]);
  }
  await rm(archiveFile, { force: true });
}

/** 将 Chromium 拷入应用包并生成 manifest（主进程据此解析可执行文件路径）。 */
async function bundlePlaywrightBrowser(applicationDirectory) {
  const { browserDirectory, browserDirectoryName, executableRelativePath } =
    await ensurePlaywrightChromium();
  const targetDirectory = join(
    applicationDirectory,
    "api",
    "playwright-browsers",
  );
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  await cp(browserDirectory, join(targetDirectory, browserDirectoryName), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await writeFile(
    join(targetDirectory, "manifest.json"),
    `${JSON.stringify({ executableRelativePath }, null, 2)}\n`,
  );
  console.log(`已内置 Playwright Chromium：${browserDirectoryName}`);
}

/** 下载并缓存目标平台的 FFmpeg 静态构建，返回 ffmpeg 二进制路径。 */
async function ensureFfmpeg() {
  const platformArch = `${targetPlatform}-${targetArch}`;
  const cacheDirectory = join(stageRoot, "ffmpeg", platformArch);
  if (targetPlatform === "darwin") {
    // macOS：ffmpeg-static 提供裸可执行文件，下载后直接作为缓存二进制。
    const cachedBinary = join(cacheDirectory, "ffmpeg");
    if (existsSync(cachedBinary)) {
      console.log(`复用已缓存的 FFmpeg（${platformArch}）。`);
      return cachedBinary;
    }
    const url = `${FFMPEG_DARWIN_RELEASE}/ffmpeg-darwin-${targetArch}`;
    console.log(`下载 FFmpeg 静态构建（${platformArch}）…`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`下载 FFmpeg 失败（${response.status}）：${url}`);
    }
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      cachedBinary,
      Buffer.from(await response.arrayBuffer()),
    );
    await run("chmod", ["+x", cachedBinary]);
    return cachedBinary;
  }
  const archiveName = FFMPEG_ARCHIVE_NAME[platformArch];
  const binaryInArchive = FFMPEG_BINARY_IN_ARCHIVE[platformArch];
  if (!archiveName || !binaryInArchive) {
    throw new Error(`缺少 ${platformArch} 的 FFmpeg 压缩包映射。`);
  }
  const cachedBinary = join(cacheDirectory, binaryInArchive);
  if (existsSync(cachedBinary)) {
    console.log(`复用已缓存的 FFmpeg（${platformArch}）。`);
    return cachedBinary;
  }
  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(cacheDirectory, { recursive: true });
  const url = `${FFMPEG_RELEASE_BASE}/${archiveName}`;
  const archivePath = join(stageRoot, archiveName);
  console.log(`下载 FFmpeg 静态构建（${archiveName}）…`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载 FFmpeg 失败（${response.status}）：${url}`);
  }
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  if (process.platform === "darwin") {
    await run("ditto", ["-x", "-k", archivePath, cacheDirectory]);
  } else {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${cacheDirectory}'`,
    ]);
  }
  await rm(archivePath, { force: true });
  if (!existsSync(cachedBinary)) {
    throw new Error(`FFmpeg 解压后未在预期路径找到二进制：${cachedBinary}`);
  }
  return cachedBinary;
}

/** 将 FFmpeg 二进制拷入应用包并生成 manifest（主进程据此解析路径）。 */
async function bundleFfmpeg(applicationDirectory) {
  const ffmpegBinary = await ensureFfmpeg();
  const targetDirectory = join(applicationDirectory, "api", "ffmpeg");
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  const binaryName =
    targetPlatform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  await cp(ffmpegBinary, join(targetDirectory, binaryName));
  await writeFile(
    join(targetDirectory, "manifest.json"),
    `${JSON.stringify({ executable: binaryName }, null, 2)}\n`,
  );
  console.log(`已内置 FFmpeg：${binaryName}`);
}
