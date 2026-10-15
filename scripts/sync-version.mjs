// Copies the version from package.json into every file that pins it.
// Runs automatically from `npm version <x>`; `--check` only verifies (used by the release workflow).
import fs from "node:fs";

const check = process.argv.includes("--check");
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const edits = [
  ["src/version.ts", /VERSION = "[^"]+"/, `VERSION = "${version}"`],
  ["plugin.json", /"version": "[^"]+"/, `"version": "${version}"`],
  [".claude-plugin/plugin.json", /"version": "[^"]+"/, `"version": "${version}"`],
  ["mcp.json", /x-api-mcp@[^"]+"/, `x-api-mcp@${version}"`],
  [".mcp.json", /x-api-mcp@[^"]+"/, `x-api-mcp@${version}"`],
];

let stale = [];
for (const [file, re, value] of edits) {
  const text = fs.readFileSync(file, "utf8");
  if (!re.test(text)) throw new Error(`${file}: version pattern not found`);
  const next = text.replace(re, value);
  if (next === text) continue;
  if (check) stale.push(file);
  else fs.writeFileSync(file, next);
}
if (stale.length) {
  console.error(`Version ${version} is not applied to: ${stale.join(", ")}. Run: node scripts/sync-version.mjs`);
  process.exit(1);
}
console.log(check ? `All files are at ${version}` : `Synced version ${version}`);
