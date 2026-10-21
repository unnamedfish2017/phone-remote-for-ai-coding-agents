// Runs every tests/*.test.mjs with the built-in test runner. Passing explicit file names works on every
// Node version we support; `node --test "tests/*.test.mjs"` needs glob support that only newer Node has.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "tests");
const files = readdirSync(dir).filter(f => f.endsWith(".test.mjs")).sort().map(f => path.join("tests", f));
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
