import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

if (process.platform !== "darwin") {
  console.log("Skipping native macOS icon build on this platform.");
  process.exit(0);
}

const root = resolve(new URL("..", import.meta.url).pathname);
const source = resolve(root, "assets", "AppIcon.icon");
const destination = resolve(root, "build", "generated", "Assets.car");
const xcodeDeveloperDir = "/Applications/Xcode.app/Contents/Developer";
const developerDir =
  process.env.DEVELOPER_DIR ||
  (existsSync(xcodeDeveloperDir) ? xcodeDeveloperDir : undefined);
const env = developerDir
  ? { ...process.env, DEVELOPER_DIR: developerDir }
  : process.env;
const temp = mkdtempSync(join(tmpdir(), "colima-icon-"));
const output = join(temp, "output");

mkdirSync(output, { recursive: true });

try {
  execFileSync(
    "xcrun",
    [
      "actool",
      source,
      "--compile",
      output,
      "--output-format",
      "human-readable-text",
      "--notices",
      "--warnings",
      "--output-partial-info-plist",
      join(output, "assetcatalog_generated_info.plist"),
      "--app-icon",
      "AppIcon",
      "--include-all-app-icons",
      "--enable-on-demand-resources",
      "NO",
      "--development-region",
      "en",
      "--target-device",
      "mac",
      "--minimum-deployment-target",
      "26.0",
      "--platform",
      "macosx",
    ],
    { cwd: root, env, stdio: "inherit" },
  );

  const compiled = join(output, "Assets.car");
  if (!existsSync(compiled)) {
    throw new Error("actool did not produce Assets.car");
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(compiled, destination);
  console.log(`Compiled native macOS icon: ${destination}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
