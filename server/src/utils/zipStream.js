/**
 * Minimal ZIP writer — enough to package a backup bundle for download.
 *
 * WHY NOT A LIBRARY
 * `archiver` and `jszip` would each pull a dependency tree into a project that currently has none
 * for this, and the download path needs exactly one feature: put these files in a zip. The STORE
 * method (no compression) is used because the bundle's bulk is already-gzipped dumps and JPEG
 * media, which do not compress again — so deflate would cost CPU on a serverless function and save
 * almost nothing.
 *
 * WHY NOT SHELL OUT TO tar/zip
 * Tried first. Git Bash's GNU tar ignores `-a` and writes a .tar under a .zip name, and Windows'
 * native tar.exe was not reachable from the Node child process in this environment. Depending on
 * which binary happens to be on PATH is not something a restore path should rest on.
 *
 * FORMAT NOTES
 * Writes a standard ZIP: local header per entry, then the central directory, then the EOCD record.
 * Sizes are 32-bit, so this is good to 4 GB — a bundle is ~28 MB. Everything is buffered in memory
 * for the same reason: at this size streaming adds complexity for no benefit.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** DOS date/time, which is what ZIP stores. Second precision is halved — that is the format. */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/** Every file under `dir`, as paths relative to it, with forward slashes (ZIP requires those). */
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

/**
 * Zips a directory tree into a single Buffer.
 *
 * @param {string} sourceDir  directory to package
 * @param {string} prefix     folder name to nest everything under inside the zip, so extracting
 *                            never scatters files into the user's Downloads folder
 */
function zipDirectory(sourceDir, prefix = '') {
  const files = walk(sourceDir);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.full);
    const nameStr = prefix ? `${prefix}/${file.rel}` : file.rel;
    const name = Buffer.from(nameStr, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const { time, day } = dosDateTime(fs.statSync(file.full).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(0, 8);            // method 0 = STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length

    chunks.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);             // extra
    dir.writeUInt16LE(0, 32);             // comment
    dir.writeUInt16LE(0, 34);             // disk number
    dir.writeUInt16LE(0, 36);             // internal attrs
    dir.writeUInt32LE(0, 38);             // external attrs
    dir.writeUInt32LE(offset, 42);        // offset of local header

    central.push(dir, name);
    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);      // end of central directory
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** CRC-32 fallback for Node versions without zlib.crc32 (added in Node 20.12). */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

module.exports = { zipDirectory };
