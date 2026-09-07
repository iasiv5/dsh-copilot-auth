// 测试共享基建：最小 ustar/tgz 构造器，供 catalog / catalog-fetch / host 测试复用。
import { gzipSync } from "node:zlib";

// entries = [{ name, content(Buffer|string) }]。只支持 <=100 字符路径的普通文件，
// 生成带正确 checksum 的 ustar 归档（末尾两个零块）。
export function tar(entries) {
  const blocks = [];
  for (const { name, content } of entries) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    if (Buffer.byteLength(name) > 100) throw new Error("fixture name too long for ustar name field");
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "latin1");
    header.write("0000644\0", 100, 8, "latin1");
    header.write("0000000\0", 108, 8, "latin1");
    header.write("0000000\0", 116, 8, "latin1");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "latin1");
    header.write("00000000000\0", 136, 12, "latin1");
    header.write("        ", 148, 8, "latin1"); // 计算期间 checksum 字段按空格计
    header.write("0", 156, 1, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
    blocks.push(header, body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export function tgz(entries) {
  return gzipSync(tar(entries));
}
