#!/usr/bin/env node
// 版本号管理：三段 semver，第三段 = 出包次数（0.1.1、0.1.2、…、0.1.10）。
// 用法：
//   node scripts/version.mjs show
//   node scripts/version.mjs bump     # 第三段 +1，写回 version.json / package.json / tauri.conf.json
//   node scripts/version.mjs set 0.1.5
//
// 注意：Tauri 的 version 必须是三段 semver，因此这里不需要四段；
// Android 的 versionName 用同一字符串，versionCode 由 build-android-apk.ps1 计算为单调整数。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = path.join(root, "version.json");
const packageFile = path.join(root, "package.json");
const tauriConfigFile = path.join(root, "src-tauri", "tauri.conf.json");
const cargoFile = path.join(root, "src-tauri", "Cargo.toml");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

/** Cargo.toml 只替换 [package] 段的 version 行，保留其余格式与注释。 */
function writeCargoVersion(version) {
  const text = fs.readFileSync(cargoFile, "utf8");
  const updated = text.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
  if (updated === text && !text.includes(`version = "${version}"`)) {
    throw new Error(`无法在 ${cargoFile} 写入版本号`);
  }
  fs.writeFileSync(cargoFile, updated, "utf8");
}

function readState() {
  const raw = readJson(versionFile);
  return { major: Number(raw.major), minor: Number(raw.minor), build: Number(raw.build) };
}

function format(state) {
  return `${state.major}.${state.minor}.${state.build}`;
}

function apply(state) {
  const version = format(state);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`非法版本号：${version}`);
  }
  writeJson(versionFile, state);
  const pkg = readJson(packageFile);
  pkg.version = version;
  writeJson(packageFile, pkg);
  const tauri = readJson(tauriConfigFile);
  tauri.version = version;
  writeJson(tauriConfigFile, tauri);
  writeCargoVersion(version);
  console.log(`version = ${version}（Android versionCode = ${state.major * 1000000 + state.minor * 10000 + state.build * 100}）`);
}

const [command, arg] = process.argv.slice(2);
const state = readState();

switch (command) {
  case "show":
    console.log(format(state));
    break;
  case "bump":
    state.build += 1;
    apply(state);
    break;
  case "set": {
    if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) throw new Error("用法：node scripts/version.mjs set 0.1.5");
    const [major, minor, build] = arg.split(".").map(Number);
    apply({ major, minor, build });
    break;
  }
  default:
    console.log("用法：node scripts/version.mjs show|bump|set <major.minor.build>");
    process.exitCode = 1;
}
