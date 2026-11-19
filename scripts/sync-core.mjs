// Builds the core library and copies its browser bundle into the desktop app.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execSync("npm run build --silent", { cwd: join(root, "core"), stdio: "inherit" });
mkdirSync(join(root, "desktop/src/vendor"), { recursive: true });
copyFileSync(join(root, "core/dist/akko.js"), join(root, "desktop/src/vendor/akko.js"));
console.log("core → desktop/src/vendor/akko.js");
