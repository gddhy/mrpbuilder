// 从 assets/app.js 里原样搬出来的报错提取逻辑，单独跑一遍确认行为。
// （直接 import app.js 会触发 DOM 相关代码，所以这里复制常量与函数。）

const ERROR_PAT = new RegExp(
  [
    'undefined reference',
    'error:',
    'Error \\d',
    '\\bld:',
    'collect2:',
    'make(\\[\\d+\\])?: \\*\\*\\*',
    'No such file',
    'cannot (find|execute|open)',
    '\\bfatal error',
    '编译失败',
  ].join('|'),
  'i'
);

function extractErrors(text) {
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((ln, i) => {
    if (!ERROR_PAT.test(ln)) return;
    keep.add(i);
    for (const k of [i - 1, i + 1]) {
      if (k >= 0 && k < lines.length && /in function /.test(lines[k])) keep.add(k);
    }
  });
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join('\n');
}

// 用用户截图里的真实输出当样本
const sample = [
  '/opt/tc/usr/bin/ld: /tmp/ccxba9Ul.o: in function `bmp_drawFanShape\':',
  'bitmap.c:(.text+0x4d34): undefined reference to `atan2\'',
  '/opt/tc/usr/bin/ld: /tmp/ccxba9Ul.o: in function `bmp_drawShadeMirrorCircle\':',
  'bitmap.c:(.text+0x2120): undefined reference to `sqrt\'',
  '/opt/tc/usr/bin/ld: /tmp/ccba0iQK.o: in function `freeDisplayObject\':',
  'display_object.c:(.text+0x8d8): undefined reference to `memset\'',
  '这是正常输出，应该被过滤掉',
  'bitmap.c:123: warning: unused variable \'x\' [-Wunused-variable]',
  'collect2: error: ld returned 1 exit status',
  'make: *** [Makefile:32: bin.elf] Error 1',
].join('\n');

const out = extractErrors(sample);
console.log('--- 提取结果 ---');
console.log(out);
console.log('--- 校验 ---');
const must = ['atan2', 'sqrt', 'memset', 'in function `bmp_drawFanShape\'', 'Error 1'];
const mustNot = ['正常输出', 'warning: unused variable'];
let ok = true;
for (const m of must) {
  const has = out.includes(m);
  if (!has) ok = false;
  console.log(`  ${has ? '✓' : '✗'} 应包含: ${m}`);
}
for (const m of mustNot) {
  const has = out.includes(m);
  if (has) ok = false;
  console.log(`  ${has ? '✗' : '✓'} 应排除: ${m}`);
}
console.log(ok ? '\n全部通过' : '\n有失败项');
process.exit(ok ? 0 : 1);
