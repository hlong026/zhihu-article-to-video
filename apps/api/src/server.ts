import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 3001);
const databasePath = resolve(
  process.env.DATA_DIR ?? "data",
  "zhihu-video.sqlite",
);
await mkdir(dirname(databasePath), { recursive: true });

const app = buildApp({
  databasePath,
  outputDirectory: process.env.OUTPUT_DIR ?? resolve(process.cwd(), "outputs"),
  logger: true,
});
await app.listen({ port, host: "127.0.0.1" });
