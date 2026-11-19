import { build } from "esbuild";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const common = { bundle: true, loader: { ".css": "text" }, target: "es2020", legalComments: "none" };
// ES module for bundlers / <script type="module">
await build({ ...common, entryPoints: ["src/index.ts"], format: "esm", outfile: "dist/akko.js", minify: true, sourcemap: true });
// React wrapper (react stays external)
await build({ ...common, entryPoints: ["src/react.ts"], format: "esm", outfile: "dist/react.js", minify: true, external: ["react", "./index"], plugins: [{
  name: "self", setup(b) { b.onResolve({ filter: /^\.\/index$/ }, () => ({ path: "./akko.js", external: true })); },
}] });
// Plain <script> tag: window.Akko.createAkko(...)
await build({ ...common, entryPoints: ["src/index.ts"], format: "iife", globalName: "Akko", outfile: "dist/akko.global.js", minify: true });
execSync("npx tsc -p .", { stdio: "inherit" });
console.log("built dist/");
