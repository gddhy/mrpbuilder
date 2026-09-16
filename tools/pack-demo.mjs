/**
 * 命令行打包器：把 mrp_demo 打成一个 .mrp（不需要浏览器）
 *
 * 用法：
 *   node tools/pack-demo.mjs --display "我的应用" --appid 30001 --version 1 \
 *        --vendor "AI Studio" --desc "一句话介绍" --out dist/demo.mrp
 *
 * 常用参数：
 *   --display   显示名（必填，GBK ≤24 字节）
 *   --internal  内部名，写入文件头 [16]，默认取 --out 的文件名（GBK ≤12 字节）
 *   --appid     默认 30001
 *   --version   默认 1
 *   --vendor    开发者（GBK ≤40）
 *   --desc      介绍（GBK ≤64）
 *   --auth      授权串，默认 ea50027c8（取自本机现有可运行的 mrp）
 *   --flag      默认 7（可见 + CPU 3 + start 启动）
 *   --sw --sh   屏幕宽高，默认 0 0（与真实样本一致）
 *   --elf       bin.elf 路径，默认 .build/bin.elf
 *   --start / --cfunction   壳文件路径，默认取 mrp_demo/lib/ 下的
 *   --res       追加一个资源（可重复）；默认自动挑 mrp_demo/ 下的非源码文件
 *   --no-res    不打包任何资源
 *   --out       输出路径，默认 dist/<internal 去掉扩展名>.mrp
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { packMrp, parseMrp, prepareFiles, isResourceCandidate, encodeGBKDetailed } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'mrp-pack.js')).href
);
// 体积文案与网页端共用同一份实现（assets/bytes.js）
const { fmtBytes } = await import(pathToFileURL(path.join(ROOT, 'assets', 'bytes.js')).href);

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return dflt;
}
function flag(name) {
  return argv.includes(`--${name}`);
}
function multi(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
}

const DEMO = path.join(ROOT, 'mrp_demo');
const display = arg('display');
if (!display) {
  console.error('缺少 --display（显示名）。例如：');
  console.error('  node tools/pack-demo.mjs --display "我的应用" --appid 30001 --vendor "AI Studio"');
  process.exit(2);
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const need = (p, what) => {
  if (!fs.existsSync(p)) {
    console.error(`找不到${what}：${p}`);
    process.exit(2);
  }
  return p;
};

const elfPath = need(path.resolve(ROOT, arg('elf', '.build/bin.elf')), ' bin.elf（先编译，或用 --elf 指定）');
const startPath = need(path.resolve(ROOT, arg('start', path.join(DEMO, 'lib/start.mr'))), ' start.mr');
const cfuncPath = need(path.resolve(ROOT, arg('cfunction', path.join(DEMO, 'lib/cfunction.ext'))), ' cfunction.ext');

// ---- 资源清单 ----
let resPaths = [];
if (!flag('no-res')) {
  const extra = multi('res');
  if (extra.length) {
    resPaths = extra.map((p) => path.resolve(ROOT, p));
  } else {
    // 与浏览器界面同一套规则：排除 src/、lib/、Makefile、源码与文档
    const walk = (dir, prefix = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const r = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (isResourceCandidate(r)) resPaths.push(path.join(dir, e.name));
      }
    };
    walk(DEMO);
    resPaths.sort();
  }
}

// ---- 组装 ----
const out = path.resolve(ROOT, arg('out', path.join('dist', 'demo.mrp')));
const internal = arg('internal', path.basename(out));

const raw = [
  { name: 'start.mr', data: fs.readFileSync(startPath) },
  { name: 'bin.elf', data: fs.readFileSync(elfPath) },
  ...resPaths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) })),
  { name: 'cfunction.ext', data: fs.readFileSync(cfuncPath) },
];

const seen = new Map();
for (const f of raw) seen.set(f.name, (seen.get(f.name) || 0) + 1);
const dups = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
if (dups.length) {
  console.error(`打包清单里有重名文件：${dups.join('、')}（mrp 内部只按文件名索引，会互相覆盖）`);
  process.exit(1);
}

console.log('打包清单（顺序固定：start.mr → bin.elf → 资源 → cfunction.ext）');
console.log('  序号  文件名               原始大小     → gzip 后');
const prepared = await prepareFiles(raw, (i, total, name) => {
  process.stdout.write(`\r  压缩中 ${i}/${total} ${name}                    `);
});
process.stdout.write('\r' + ' '.repeat(60) + '\r');

const meta = {
  fileName: internal,
  displayName: display,
  vendor: arg('vendor', ''),
  desc: arg('desc', ''),
  authStr: arg('auth', 'ea50027c8'),
  appid: Number(arg('appid', 30001)),
  version: Number(arg('version', 1)),
  flag: Number(arg('flag', 7)),
  screenWidth: Number(arg('sw', 0)),
  screenHeight: Number(arg('sh', 0)),
};

const { bytes, entries } = packMrp({ ...meta, files: prepared });

for (const [i, e] of entries.entries()) {
  const rawLen = raw[i].data.length;
  const pct = rawLen ? `  (${((e.size / rawLen) * 100).toFixed(0)}%)` : '';
  console.log(
    `  ${String(i + 1).padStart(3)}   ${e.name.padEnd(18)} ${fmtBytes(rawLen).padStart(10)}  → ${fmtBytes(e.size).padStart(10)}${pct}`
  );
}

// ---- 自检 ----
const parsed = parseMrp(bytes);
const problems = parsed.verify();
const h = parsed.header;
console.log('\n文件头');
const rows = [
  ['显示名 displayName', h.displayName],
  ['内部名 fileName', h.fileName],
  ['appid', `${h.appid}（大端字段 ${h.appidBE}）`],
  ['版本 version', `${h.version}（大端字段 ${h.versionBE}）`],
  ['开发者 vendor', h.vendor],
  ['介绍 desc', h.desc],
  ['授权串 authStr', h.authStr],
  ['flag / builder / plat', `${h.flag} / ${h.builderVersion} / ${h.plat}`],
  ['屏宽高', `${h.screenWidth} x ${h.screenHeight}`],
  ['fileStart', `${h.fileStart}（= 240 + 列表长 - 8）`],
  ['总长', `${h.totalLen.toLocaleString()}`],
  ['CRC32', `0x${h.crc32.toString(16).padStart(8, '0')}`],
];
for (const [k, v] of rows) console.log(`  ${k.padEnd(22)} ${v}`);
console.log(`\n自检：${problems.length ? '✗ ' + problems.join('；') : '✓ 头 / 列表区 / 偏移 / CRC 全部自洽'}`);

// 截断与不可编码提示
for (const [label, value, limit] of [
  ['显示名', meta.displayName, 24],
  ['内部名', meta.fileName, 12],
  ['开发者', meta.vendor, 40],
  ['介绍', meta.desc, 64],
  ['授权串', meta.authStr, 16],
]) {
  const { bytes: b, missed } = encodeGBKDetailed(value);
  if (b.length > limit) console.log(`  ⚠ ${label} GBK ${b.length} 字节，超过 ${limit}，已截断`);
  if (missed.length) console.log(`  ⚠ ${label} 中 ${[...new Set(missed)].join('')} 无法用 GBK 表示，已变成 ?`);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, bytes);
console.log(`\n✓ 已生成 ${rel(out)}（${fmtBytes(bytes.length)}）`);
console.log(`  校验：python tools/dev-inspect-mrp.py ${rel(out)}`);
process.exit(problems.length ? 1 : 0);
