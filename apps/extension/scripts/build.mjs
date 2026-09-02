import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

await mkdir(dist, { recursive: true });
await build({
  entryPoints: {
    background: path.join(root, "src/background.js"),
    content: path.join(root, "src/content.js"),
    popup: path.join(root, "src/popup.js"),
  },
  bundle: true,
  format: "iife",
  outdir: dist,
  entryNames: "[name]",
  target: "chrome120",
  sourcemap: true,
});
await Promise.all([
  cp(path.join(root, "public/manifest.json"), path.join(dist, "manifest.json")),
  cp(path.join(root, "popup.html"), path.join(dist, "popup.html")),
  cp(path.join(root, "popup.css"), path.join(dist, "popup.css")),
]);

console.log(`Built extension at ${dist}`);
