#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(root, "node_modules", "typescript"))) {
  const install = spawnSync("pnpm", ["install", "--prod", "--frozen-lockfile"], { cwd: root, stdio: "ignore", shell: process.platform === "win32" });
  if (install.status !== 0) {
    process.stdout.write(`slopgate could not install its dependencies. Tell the user to run: pnpm install --prod --dir "${root}"\n\n`);
  }
}

process.stdout.write(readFileSync(join(root, "rules.txt"), "utf8"));
