import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createICO, createICNS } = require("png2icons");

const resourcesDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
);
const sourcePath = join(resourcesDirectory, "icon.png");

// png2icons 以整张 PNG 为输入，内部缩放生成多尺寸图标；
// output 传 undefined 由其自行分配缓冲区，bpp=0 沿用源图位深，不压缩。
const source = await readFile(sourcePath);

const ico = createICO(source, undefined, 0, false);
if (!ico) {
  throw new Error("生成 icon.ico 失败，请确认 resources/icon.png 为有效 PNG。");
}
await writeFile(join(resourcesDirectory, "icon.ico"), ico);

const icns = createICNS(source, undefined, 0, false);
if (!icns) {
  throw new Error("生成 icon.icns 失败，请确认 resources/icon.png 为有效 PNG。");
}
await writeFile(join(resourcesDirectory, "icon.icns"), icns);

console.log("已生成 resources/icon.ico 与 resources/icon.icns。");
