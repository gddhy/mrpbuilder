/**
 * 单测 assets/ingest.js —— 导入外来文件（拖入 / 选择文件 / 选择文件夹 / 解压 zip）时的路径规则。
 *
 * 这几条规则判错了后果都很具体：
 *   漏剥顶层目录 -> 文件被铺进 `工程/mrp_demo/src/...`，make 扫不到，编译直接失败；
 *   误剥（本来没有公共目录）-> 把 `src`、`lib` 这样的目录名吞掉，同样编译失败；
 *   漏跳垃圾文件 -> 用户选一个工程目录，把 `.git/` 里上万文件一起铺进工程。
 * 所以正反两面都用真名字夹一遍（`mrp_demo/` 用的是真实的 50 个模板文件）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isJunkEntry, commonRoot, relativeNames, parseGitignore, applyGitignore } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'ingest.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

console.log('===== isJunkEntry：该跳过的 =====');
for (const n of [
  '__MACOSX/foo',
  '__MACOSX/mrp_demo/src/base.c',
  '.DS_Store',
  'src/.DS_Store',
  'Thumbs.db',
  'assets/Thumbs.db',
  'desktop.ini',
  '.git/config',
  '.git/objects/ab/cdef1234',
  '.gitignore',
  '.vscode/settings.json',
  'src/.env',
]) {
  ok(`${n} 跳过`, isJunkEntry(n) === true);
}

console.log('\n===== isJunkEntry：不该跳过的 =====');
for (const n of [
  'helloworld.c',
  'src/base.c',
  'src/mrc_compat.h',
  'Makefile',
  'README.md',
  'assets/logo_240.png', // 名字里有下划线/数字，别被点号规则误伤
  'lib/cfunction.ext',
  'assets/font.uc3',
  'src/tables.h',
  'a/./b', // 只有「.» 加至少一个字符」才算隐藏，单独的 `.` 段不算
  'v1.2/src/main.c', // 目录名里有点但不是隐藏项
]) {
  ok(`${n} 保留`, isJunkEntry(n) === false);
}

console.log('\n===== commonRoot / relativeNames =====');
ok('空列表 → 空前缀', commonRoot([]) === '' && relativeNames([]).length === 0);
ok('只有一层文件 → 不剥', commonRoot(['a.c', 'b.h']) === '');
ok(
  '单个顶层目录 → 剥掉（这才是「选择文件夹」的情形）',
  commonRoot(['mrp_demo/Makefile', 'mrp_demo/src/base.c']) === 'mrp_demo/' &&
    relativeNames(['mrp_demo/Makefile', 'mrp_demo/src/base.c']).join(',') ===
      'Makefile,src/base.c'
);
ok(
  '顶层不统一 → 整个保留（别把 src/ 这类目录名吞掉）',
  commonRoot(['src/a.c', 'lib/b.c']) === '' &&
    relativeNames(['src/a.c', 'lib/b.c']).join(',') === 'src/a.c,lib/b.c'
);
ok(
  '顶层目录名带点也照剥（v1.2/ 不是隐藏项）',
  relativeNames(['v1.2/main.c', 'v1.2/src/x.c']).join(',') === 'main.c,src/x.c'
);

// 真实样本：镜像里 mrp_demo 的 50 个文件，按「选择文件夹」的路径形态喂进去
const TEMPLATE = [
  'Makefile',
  'README.md',
  'assets/font.uc3',
  'assets/logo_240.png',
  'helloworld.c',
  'lib/cfunction.ext',
  'lib/start.mr',
  'selftest.c',
  'src/base.c',
  'src/base.h',
  'src/mrp_compat.c',
  'src/tables.h',
  'src.old/keep.c', // 名字以 src 开头但不是 src/ —— 别被前缀判断误伤
];
const picked = TEMPLATE.map((n) => `mrp_demo/${n}`);
ok(
  `真实模板（${TEMPLATE.length} 个）全部原样还原`,
  relativeNames(picked).join(',') === TEMPLATE.join(',')
);
ok(
  '整批过滤：.git 与 .DS_Store 被跳过、其余 13 个保留',
  relativeNames(
    picked.concat(['mrp_demo/.git/config', 'mrp_demo/.DS_Store', 'mrp_demo/src/.DS_Store'])
  ).filter((n) => !isJunkEntry(n)).length === TEMPLATE.length
);

console.log('\n===== .gitignore：解析与匹配 =====');
// 一份「真实工程会写的样子」的 .gitignore
const GI = parseGitignore(
  [
    '# 依赖与产物',
    'node_modules/',
    'build/',
    'dist',
    '*.o',
    '!keep.o',
    '/target',
    'docs/**/*.tmp',
    '**/generated/',
    'my dir/',
    'file[0-9].log',
    '\\#not-comment.txt',
    '',
  ].join('\n')
);
const ig = (names, gis = [{ dir: '', rules: GI }]) => [...applyGitignore(names, gis)].sort();
const ignoredOf = (n) => ig([n]).length === 1;
const keptOf = (n) => ig([n]).length === 0;

for (const n of [
  'node_modules/react/index.js', // 目录结尾 → 整个目录（含任意深度）
  'src/node_modules/x.js', // 不带前导斜杠 → 任意层级都算
  'build/main.js',
  'dist/app.elf',
  'a.o', // 通配后缀
  'obj/deep/a.o',
  'target/x', // 前导斜杠 → 锚定在根
  'docs/a/b.tmp', // ** 跨层级
  'docs/b.tmp',
  'docs/a.tmp', // **/ 也匹配「零层」（git 文档：a/**/b 匹配 a/b）
  'x/generated/y.js', // **/xxx/ 任意层级
  'my dir/a.c', // 名字里带空格
  'file3.log', // 字符类
  '#not-comment.txt', // 转义的字面量 #
]) {
  ok(`忽略 ${n}`, ignoredOf(n));
}

for (const n of [
  'keep.o', // 被 ! 取反捞回
  'src/a.c',
  'mybuild/a.js', // 不带斜杠的 build 只匹配同名层级，不误伤 mybuild
  'sub/target/x', // /target 锚定在根，子目录里的 target 不管
  'targets/x', // 前缀相似但不相等
  'node_modules', // 结尾 / 只匹配目录；同名文件不算
  'filex.log',
]) {
  ok(`保留 ${n}`, keptOf(n));
}

ok('注释/空行/纯 ! 行不产生规则', parseGitignore('# c\n\n!  \n   \n').length === 0);
ok('行尾空格被剥掉（"build   " 等于 "build"）', ig(['build/x'], [{ dir: '', rules: parseGitignore('build   ') }]).length === 1);
ok(
  '目录被忽略后，再用 ! 捞回里面的文件无效（与 git 一致）',
  applyGitignore(['build/keep.js'], [
    { dir: '', rules: parseGitignore('build/\n!build/keep.js\n') },
  ]).size === 1
);
ok(
  '子目录里的 .gitignore 优先（只作用于自己那层）',
  (() => {
    const gis = [
      { dir: '', rules: parseGitignore('*.tmp\n') },
      { dir: 'src', rules: parseGitignore('lib/\n!x.tmp\n') },
    ];
    const got = [...applyGitignore(['lib/a.js', 'src/lib/b.js', 'src/x.tmp', 'b.tmp'], gis)].sort();
    return got.join(',') === 'b.tmp,src/lib/b.js';
  })()
);
ok(
  '没有规则时不跳过任何东西',
  applyGitignore(['a.c'], [{ dir: '', rules: parseGitignore('# 只有注释\n') }]).size === 0
);
ok(
  '典型工程目录：node_modules/build 被跳、源码保留',
  (() => {
    const names = [
      'main.c',
      'Makefile',
      'src/base.c',
      'src/base.h',
      'node_modules/pkg/index.js',
      'node_modules/pkg/package.json',
      'build/out.bin',
      'dist/app.mrp',
      'docs/readme.md',
    ];
    const got = [...applyGitignore(names, [{ dir: '', rules: GI }])].sort();
    return got.join(',') === 'build/out.bin,dist/app.mrp,node_modules/pkg/index.js,node_modules/pkg/package.json';
  })()
);

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exitCode = failed ? 1 : 0;
