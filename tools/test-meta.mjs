/**
 * 单测 assets/mrp-pack.js 的 validatePackMeta() —— 打包前的字段校验。
 *
 * 这些字段都要写进 .mrp 的固定头，填错了打出来的包在手机上就是异常表现，
 * 所以规则既要在界面拦、也要能被单独验证。规则只有一份（mrp-pack.js），
 * 这里直接 import 真实现来测，不复制一份逻辑（复制会漂移）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validatePackMeta } = await import(
  pathToFileURL(path.join(ROOT, 'assets', 'mrp-pack.js')).href
);

let failed = 0;
function ok(name, pass, detail = '') {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

/** 一份全部合法的表单，单独改一个字段来试 */
const GOOD = {
  displayName: '我的应用',
  fileName: 'my_app.mrp',
  appid: '30001',
  version: '1',
  vendor: 'AI Studio',
};

/** @returns {string|undefined} 错误字段名；通过则 undefined */
function check(patch) {
  return validatePackMeta({ ...GOOD, ...patch })?.field;
}
/** @returns {string} 错误文案 */
function msg(patch) {
  return validatePackMeta({ ...GOOD, ...patch })?.message ?? '';
}

console.log('===== validatePackMeta 字段校验 =====');

ok('全部合法时返回 null', validatePackMeta(GOOD) === null);
ok('空对象 → 显示名为空', validatePackMeta({})?.field === 'displayName');
ok('不传参数也不炸', validatePackMeta()?.field === 'displayName');

// 显示名
ok('显示名为空被拦下', check({ displayName: '' }) === 'displayName');
ok('显示名只有空格也算空', check({ displayName: '   ' }) === 'displayName');
ok('显示名可以有中文（GBK 编码）', check({ displayName: '我的应用', }) === undefined);
ok('显示名可以带空格', check({ displayName: 'My App' }) === undefined);

// 内部名：非空
ok('内部名为空被拦下', check({ fileName: '' }) === 'fileName');
ok('内部名只有空格也算空', check({ fileName: '  ' }) === 'fileName');

// 内部名：必须英文
ok('中文内部名被拦下（提示要英文）', check({ fileName: '我的应用.mrp' }) === 'fileName');
ok(
  '中文提示里点出了具体是哪些字',
  msg({ fileName: '我的应用.mrp' }).includes('我的应用'),
  msg({ fileName: '我的应用.mrp' })
);
ok('英文数字下划线短横线可以', check({ fileName: 'my-app_2.mrp' }) === undefined);
ok('大写英文可以', check({ fileName: 'MYAPP.MRP' }) === undefined);
ok('空格被拦下', check({ fileName: 'my app.mrp' }) === 'fileName');
ok('全角字符被拦下', check({ fileName: 'ａｐｐ.mrp' }) === 'fileName');
ok('emoji 被拦下', check({ fileName: 'app😀.mrp' }) === 'fileName');

// 内部名：必须 .mrp 结尾
ok('缺扩展名被拦下', check({ fileName: 'myapp' }) === 'fileName');
ok('缺扩展名的提示带建议名', msg({ fileName: 'myapp' }).includes('myapp.mrp'), msg({ fileName: 'myapp' }));
ok('别的扩展名被拦下并建议换成 .mrp', msg({ fileName: 'myapp.elf' }).includes('myapp.mrp'), msg({ fileName: 'myapp.elf' }));
ok('.MRP 大写也算过', check({ fileName: 'myapp.MRP' }) === undefined);
ok('点号在中间但结尾不是 .mrp 会被拦', check({ fileName: 'my.app.bin' }) === 'fileName');
ok('.mrp 前面只有点也算过（x..mrp）', check({ fileName: 'x..mrp' }) === undefined);

// appid
ok('appid 为空被拦下', check({ appid: '' }) === 'appid');
ok('appid 只有空格也算空', check({ appid: ' ' }) === 'appid');
ok('appid 非数字被拦下', check({ appid: 'abc' }) === 'appid');
ok('appid 小数被拦下', check({ appid: '3.5' }) === 'appid');
ok('appid 负数被拦下', check({ appid: '-1' }) === 'appid');
ok('appid 数字字符串可以', check({ appid: '0' }) === undefined);
ok('appid 传数字也认（命令行路径）', validatePackMeta({ ...GOOD, appid: 30001 }) === null);
ok('appid 传 undefined 被拦下', check({ appid: undefined }) === 'appid');

// 版本
ok('版本为空被拦下', check({ version: '' }) === 'version');
ok('版本非数字被拦下', check({ version: 'v1' }) === 'version');
ok('版本负数被拦下', check({ version: '-2' }) === 'version');
ok('版本 0 可以', check({ version: '0' }) === undefined);
ok('版本传数字也认', validatePackMeta({ ...GOOD, version: 2 }) === null);

// 开发者
ok('开发者为空被拦下', check({ vendor: '' }) === 'vendor');
ok('开发者只有空格也算空', check({ vendor: '  ' }) === 'vendor');
ok('开发者传 undefined 被拦下', check({ vendor: undefined }) === 'vendor');
ok('开发者可以有中文', check({ vendor: '张三' }) === undefined);

// 顺序：一次只报第一条，报的是表单从上到下的顺序
ok(
  '多个字段都错时先报显示名',
  validatePackMeta({ displayName: '', fileName: '', appid: '', version: '', vendor: '' })?.field === 'displayName'
);
ok(
  '显示名 OK 时下一个报内部名',
  validatePackMeta({ displayName: 'x', fileName: '', appid: '', version: '', vendor: '' })?.field === 'fileName'
);
ok(
  '前两个 OK 时报 appid',
  validatePackMeta({ displayName: 'x', fileName: 'a.mrp', appid: '', version: '', vendor: '' })?.field === 'appid'
);
ok(
  '报错误文案都非空',
  [
    { displayName: '' },
    { fileName: '' },
    { fileName: '中文.mrp' },
    { fileName: 'a' },
    { appid: '' },
    { version: '' },
    { vendor: '' },
  ].every((p) => msg(p).length > 0)
);

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
process.exit(failed ? 1 : 0);
