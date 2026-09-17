/**
 * 极简静态服务器（本地开发用，顺便当复现工具）。
 *
 * 用法：
 *   node tools/dev-server.mjs                    # 普通静态服务，默认 8000
 *   node tools/dev-server.mjs --port 8080
 *   node tools/dev-server.mjs --gzip-static      # 复现 nginx gzip_static 行为
 *
 * 为什么要自己写一个而不是用 `python -m http.server`：
 * 需要一个能复现「gzip_static 把 .tar.gz 搞坏」的开关。
 *
 * 有些静态服务器 / CDN 会把 `foo.tar.gz` 当成「foo.tar 的 gzip 压缩表示」，
 * 于是在客户端声明 `Accept-Encoding: gzip` 时，直接回
 * `Content-Encoding: gzip` + 文件原始字节。浏览器见 Content-Encoding 就会
 * 自动解压一次 —— 而文件本身已经是 gzip 了，于是页面收到的是**未压缩的 tar**。
 * 推给虚拟机后 `gzip -dc` 报 "gzip: invalid magic"、tar 再报 short read，
 * 两个报错都指不到真正原因。
 *
 * `--gzip-static` 就是用来复现（并回归验证）这个场景的：
 * 打开后，页面应当能自己发现"拿到的不是 gzip"，重新压缩后正常安装。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8000;
const GZIP_STATIC = argv.includes('--gzip-static');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.mrp': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  // 注意：req.url 可能是 "//"（协议相对形式），new URL 会直接抛
  // ERR_INVALID_URL。不做捕获的话整个 server 会挂掉、后续请求全部连接失败。
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  // 防目录穿越
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  if (st.isDirectory()) {
    res.writeHead(302, { Location: rel + '/' }).end();
    return;
  }

  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'no-store',
  };

  // 复现 gzip_static：.gz 文件直接标成 Content-Encoding: gzip 并原样送出
  if (GZIP_STATIC && file.endsWith('.gz')) {
    headers['Content-Encoding'] = 'gzip';
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers).end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-server] http://127.0.0.1:${PORT}/`);
  console.log(`[dev-server] root = ${ROOT}`);
  if (GZIP_STATIC) {
    console.log('[dev-server] ⚠ --gzip-static 已开启：.gz 会带 Content-Encoding: gzip');
    console.log('[dev-server]    （页面拿到的 rootfs.tar.gz 会是解压后的 tar，用于回归验证）');
  }
});
