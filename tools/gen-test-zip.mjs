// 生成含真实 main.c 的测试 zip（正向入口判断用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { zipStore } = await import(pathToFileURL(path.join(ROOT, 'assets/zip.js')).href);

const enc = new TextEncoder();
const files = [
  { name: 'src/util.c', data: enc.encode('#include "util.h"\nint add(int a,int b){return a+b;}\n') },
  { name: 'src/util.h', data: enc.encode('int add(int,int);\n') },
  { name: 'main.c', data: enc.encode('#include "src/util.h"\nint main(void){ return add(1,2); }\n') },
  { name: 'res/logo.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
];
const out = path.join(ROOT, '.build', 'test-entry.zip');
fs.writeFileSync(out, zipStore(files));
console.log('written', out);
