import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(
  execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], {
    cwd: root,
    encoding: "utf8",
  }),
);

const profile = process.env.APPLE_KEYCHAIN_PROFILE;
if (!profile) {
  throw new Error("APPLE_KEYCHAIN_PROFILE is required to notarize the DMG.");
}

const identity =
  process.env.CSC_NAME ||
  "Developer ID Application: NICHOLAS ANTHONY CARFAGNO (8SL5R8268H)";
const arch = process.env.MAC_DMG_ARCH || process.arch;
const dmgPath = resolve(
  root,
  process.argv[2] ||
    join("dist", `${pkg.build.productName}-${pkg.version}-${arch}.dmg`),
);

if (!existsSync(dmgPath)) {
  throw new Error(`DMG not found: ${dmgPath}`);
}

run("codesign", ["--force", "--sign", identity, "--timestamp", dmgPath]);
run("xcrun", [
  "notarytool",
  "submit",
  dmgPath,
  "--keychain-profile",
  profile,
  "--wait",
]);
run("xcrun", ["stapler", "staple", dmgPath]);
run("xcrun", ["stapler", "validate", dmgPath]);
run("spctl", ["-a", "-vvv", "-t", "install", dmgPath]);

const appBuilder = resolve(
  root,
  "node_modules",
  "app-builder-bin",
  "mac",
  process.arch === "arm64" ? "app-builder_arm64" : "app-builder_amd64",
);
run(appBuilder, ["blockmap", "--input", dmgPath, "--output", `${dmgPath}.blockmap`]);

const dmg = statSync(dmgPath);
const blockmap = statSync(`${dmgPath}.blockmap`);
console.log(`Finalized ${basename(dmgPath)} (${dmg.size} bytes)`);
console.log(`Regenerated ${basename(dmgPath)}.blockmap (${blockmap.size} bytes)`);

function run(command, args) {
  console.log(`> ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}
