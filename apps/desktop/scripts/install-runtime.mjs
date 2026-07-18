import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronEntry = require.resolve("electron");
const electronDirectory = dirname(electronEntry);
const electronPackage = require(join(electronDirectory, "package.json"));
const platformPath =
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : "electron.exe";
const binaryPath = join(electronDirectory, "dist", platformPath);

if (existsSync(binaryPath)) {
  console.log("Electron 运行时已就绪。");
  process.exit(0);
}

if (process.platform !== "darwin" && process.platform !== "win32") {
  throw new Error("仅支持在 macOS 或 Windows 上准备 Electron 运行时。");
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
  `正在下载 Electron ${electronPackage.version} 的 ${process.platform}-${process.arch} 运行时…`,
);
// Node 24 may not keep the event loop alive for the downloader's network request.
// Keep this process alive only until the awaited download has settled.
const keepAlive = setInterval(() => undefined, 1_000);
let archive;
try {
  archive = await downloadArtifact({
    version: electronPackage.version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
    checksums: require(join(electronDirectory, "checksums.json")),
  });
} finally {
  clearInterval(keepAlive);
}
console.log(`已获取 Electron 归档：${archive}`);

await mkdir(join(electronDirectory, "dist"), { recursive: true });
await extract(archive, { dir: join(electronDirectory, "dist") });
console.log("Electron 归档已解压。");
await writeFile(join(electronDirectory, "path.txt"), platformPath);

if (!existsSync(binaryPath)) {
  throw new Error("Electron 运行时解压后缺少主程序。");
}

// Electron archive carries a duplicate declaration file at its root.
const bundledDeclaration = join(electronDirectory, "dist", "electron.d.ts");
if (existsSync(bundledDeclaration)) {
  await rename(bundledDeclaration, join(electronDirectory, "electron.d.ts"));
}

console.log(`Electron ${electronPackage.version} 运行时已准备完成。`);
