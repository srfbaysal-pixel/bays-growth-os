// Basit PNG ikon üretici (bağımlılıksız): mavi zemin + beyaz "B" piksel harfi
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const B = ['01111110000', '01111111000', '01100011100', '01100001100', '01100011100', '01111111000', '01111111000', '01100011100', '01100001100', '01100011100', '01111111000', '01111110000'];
function png(size, pad) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cell = Math.floor((size * (1 - 2 * pad)) / 14);
  const ox = Math.floor((size - cell * 11) / 2), oy = Math.floor((size - cell * 12) / 2);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) {
    const gx = Math.floor((x - ox) / cell), gy = Math.floor((y - oy) / cell);
    const on = gy >= 0 && gy < 12 && gx >= 0 && gx < 11 && B[gy][gx] === '1';
    const i = y * (size * 4 + 1) + 1 + x * 4; raw[i] = on ? 255 : 0x1d; raw[i + 1] = on ? 255 : 0x4e; raw[i + 2] = on ? 255 : 0xd8; raw[i + 3] = 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, 0.18));
writeFileSync('public/icons/icon-512.png', png(512, 0.18));
writeFileSync('public/icons/icon-512-maskable.png', png(512, 0.28));
console.log('ikonlar yazıldı');
