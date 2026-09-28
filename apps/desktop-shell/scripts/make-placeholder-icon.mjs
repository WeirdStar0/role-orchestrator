// 一次性生成器:纯字节构造一个最小但完全合法的 32x32 32bpp .ico(不透明
// 纯色方块),仅供 tauri-build/generate_context! 的图标嵌入与 Windows 资源
// 编译使用——本壳不自带 UI 美术,正式图标属 M8-03c 打包分发阶段。
//
// 结构:ICONDIR(6B) + ICONDIRENTRY(16B) + BITMAPINFOHEADER(40B,biHeight
// = 高×2,含 XOR 像素 + AND 掩码) + XOR 像素(32*32*4B BGRA,alpha=FF)
// + AND 掩码(32 行 × 4B,全 0 = 不透明)。
//
// 运行:node scripts/make-placeholder-icon.mjs [输出路径]
// (默认写到 ../icons/icon.ico;产物入库,本脚本保留以便再生)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultOut = resolve(dirname(fileURLToPath(import.meta.url)), "..", "icons", "icon.ico");
const out = process.argv[2] ?? defaultOut;

const WIDTH = 32;
const HEIGHT = 32;
const xorBytes = WIDTH * HEIGHT * 4; // 32bpp BGRA
const andRowBytes = Math.ceil(WIDTH / 8); // 4 bytes per row
const andBytes = andRowBytes * HEIGHT;
const biSizeImage = xorBytes + andBytes;
const imageSize = 40 + biSizeImage;

const buf = Buffer.alloc(6 + 16 + imageSize);
let o = 0;
// ICONDIR: reserved=0, type=1(icon), count=1
buf.writeUInt16LE(0, o); o += 2;
buf.writeUInt16LE(1, o); o += 2;
buf.writeUInt16LE(1, o); o += 2;
// ICONDIRENTRY: 32x32, 0 palette entries, planes=1, bpp=32
buf.writeUInt8(WIDTH, o); o += 1;
buf.writeUInt8(HEIGHT, o); o += 1;
buf.writeUInt8(0, o); o += 1;
buf.writeUInt8(0, o); o += 1;
buf.writeUInt16LE(1, o); o += 2;
buf.writeUInt16LE(32, o); o += 2;
buf.writeUInt32LE(imageSize, o); o += 4;
buf.writeUInt32LE(22, o); o += 4; // image data offset: 6 + 16
// BITMAPINFOHEADER
buf.writeUInt32LE(40, o); o += 4; // biSize
buf.writeInt32LE(WIDTH, o); o += 4; // biWidth
buf.writeInt32LE(HEIGHT * 2, o); o += 4; // biHeight: XOR + AND planes
buf.writeUInt16LE(1, o); o += 2; // biPlanes
buf.writeUInt16LE(32, o); o += 2; // biBitCount
buf.writeUInt32LE(0, o); o += 4; // biCompression = BI_RGB
buf.writeUInt32LE(biSizeImage, o); o += 4;
buf.writeInt32LE(0, o); o += 4; // biXPelsPerMeter
buf.writeInt32LE(0, o); o += 4; // biYPelsPerMeter
buf.writeUInt32LE(0, o); o += 4; // biClrUsed (0 for 32bpp)
buf.writeUInt32LE(0, o); o += 4; // biClrImportant
// XOR 像素:不透明深灰蓝方块(B=0x24, G=0x21, R=0x1D, A=0xFF),从下往上行序——纯色无差异
for (let p = 0; p < WIDTH * HEIGHT; p++) {
  buf.writeUInt8(0x24, o); o += 1;
  buf.writeUInt8(0x21, o); o += 1;
  buf.writeUInt8(0x1d, o); o += 1;
  buf.writeUInt8(0xff, o); o += 1;
}
// AND 掩码:全 0 = 每个像素都不透明(32bpp 下冗余,但结构上必须存在;
// Buffer 分配时已清零,这里只推进游标)
o += andBytes;

if (o !== buf.length) {
  throw new Error(`internal error: wrote ${String(o)} bytes, allocated ${String(buf.length)}`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out} (${String(buf.length)} bytes, 32x32 32bpp opaque)`);
