import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "apps/web/public/icon.svg");

await Promise.all([192, 512].map((size) =>
  sharp(source)
    .resize(size, size)
    .png()
    .toFile(path.join(root, `apps/web/public/icon-${size}.png`)),
));

console.log("Generated 192px and 512px PWA icons.");
