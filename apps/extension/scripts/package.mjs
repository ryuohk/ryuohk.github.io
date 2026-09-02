// Packages the built extension into a zip the web app can hand to members, plus a
// small manifest the Import panel reads to show the version and size.
//
// Deliberately dependency-free. A zip is a handful of well-documented records, and
// writing them here avoids adding a package to the supply chain of something that
// ships to other people's browsers. The output is verified against real unzip.

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const webPublic = path.resolve(root, "../web/public");
const zipPath = path.join(webPublic, "crambot-extension.zip");
const metaPath = path.join(webPublic, "extension.json");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

async function collect(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolute = path.join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collect(absolute, name)));
    // Source maps double the download and are useless to someone installing it.
    else if (!entry.name.endsWith(".map")) files.push({ name, body: await readFile(absolute) });
  }
  return files;
}

/** Fixed 1980-01-01 timestamp so an unchanged build produces an identical zip. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.body, { level: 9 });
    const crc = crc32(file.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

try {
  await stat(dist);
} catch {
  throw new Error("Build the extension before packaging it: npm run build --workspace @crambot/extension");
}

const files = await collect(dist);
if (!files.some((file) => file.name === "manifest.json")) {
  throw new Error("Refusing to package: dist has no manifest.json, so Chrome would reject it.");
}

const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
const zip = buildZip(files);

await mkdir(webPublic, { recursive: true });
await writeFile(zipPath, zip);
await writeFile(
  metaPath,
  `${JSON.stringify(
    {
      version: manifest.version,
      files: files.length,
      bytes: zip.length,
      sha256: createHash("sha256").update(zip).digest("hex"),
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Packaged extension ${manifest.version}: ${files.length} files, ${(zip.length / 1024).toFixed(1)} kB -> ${zipPath}`);
