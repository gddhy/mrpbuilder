/**
 * 导入外来文件（拖入 / 选择文件 / 选择文件夹 / 解压 zip）时的路径规则。
 *
 * 抽成纯函数是为了能被单测直接 import（见 tools/test-ingest.mjs）——
 * 这几条规则决定「用户选中的目录名剥不剥」「哪些文件不往工程里塞」，
 * 判错了会让 .git 之类的东西铺满工程，值得钉住。
 */

/** 系统垃圾 / 隐藏项：导入时直接跳过（`.git/` 里有成千上万文件，绝不能铺进工程） */
export function isJunkEntry(name) {
  return (
    name.startsWith('__MACOSX/') ||
    /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name) ||
    /(^|\/)\.[^/]+(\/|$)/.test(name) // 隐藏文件与隐藏目录（.git/、.vscode/、.env …）
  );
}

/** 如果所有路径都以同一个顶层目录开头，返回该目录（含斜杠），否则返回空串 */
export function commonRoot(names) {
  if (!names.length) return '';
  const first = names[0].split('/')[0];
  if (!first || !names.every((n) => n.startsWith(first + '/'))) return '';
  return first + '/';
}

/**
 * 剥掉公共顶层目录 —— 「选择文件夹」拿到的路径都带用户选中的那级目录名，
 * 解压 zip 时也常常只有一层顶层目录（`mrp_demo/...`），两者用同一条规则。
 */
export function relativeNames(names) {
  const prefix = commonRoot(names);
  return prefix ? names.map((n) => n.slice(prefix.length)) : [...names];
}

// ---------------------------------------------------------------------------
// .gitignore
//
// 「选择文件夹」导入工程时，多数人不想把 node_modules / build / dist 这些
// 「本来就不入库」的东西铺进去，而它们的共同特征就是写在工程根的 .gitignore 里。
// 所以选中目录（含子目录）里的 .gitignore 会被读出来当过滤规则用。
//
// 实现的是 gitignore 的常用子集，够覆盖真实工程的写法：
//   · `#` 注释、空行、行尾空格（`\ ` 转义的空格保留）
//   · `!` 取反（后匹配的规则覆盖先匹配的）
//   · 结尾 `/` 只匹配目录
//   · 含 `/`（或以 `/` 开头）的模式锚定在 .gitignore 所在目录，否则匹配任意层级的同名项
//   · `*`（不跨 `/`）、`?`、`[...]`、`**`（跨层级）
//   · **目录被忽略 → 它下面的一切都忽略**（所以要逐级前缀判定；
//     也因此「忽略 build/ 之后再用 !build/keep.js 捞回来」不生效 —— 与 git 行为一致）
// ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把一个 glob 片段翻译成正则体（不含首尾锚点） */
function globBody(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') {
      const n = pat[i + 1];
      if (n !== undefined) {
        out += escapeRe(n);
        i++;
      } else out += '\\\\';
      continue;
    }
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++;
        if (pat[i + 1] === '/') {
          i++; // `**/` 匹配任意层（含 0 层）
          out += '(?:.*/)?';
        } else {
          out += '.*'; // `**` 跨层级
        }
      } else out += '[^/]*'; // `*` 不跨 `/`
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let cls = '';
      if (pat[j] === '!' || pat[j] === '^') {
        cls += '^';
        j++;
      }
      if (pat[j] === ']') {
        cls += '\\]';
        j++;
      }
      for (; j < pat.length && pat[j] !== ']'; j++) cls += pat[j] === '\\' ? '\\\\' : pat[j];
      if (j >= pat.length) {
        out += '\\['; // 没有闭合的 ] → 当字面量
        continue;
      }
      i = j;
      out += `[${cls}]`;
      continue;
    }
    out += escapeRe(c);
  }
  return out;
}

/**
 * 解析一份 .gitignore 的内容。
 * @returns {Array<{negate:boolean, dirOnly:boolean, test:RegExp}>}
 */
export function parseGitignore(text) {
  const rules = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, ''); // 行尾空格无意义，`\ ` 除外
    if (!line) continue;

    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1); // `\#` / `\!` 是字面量
    }

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;

    // 含 `/` 的模式锚定在 .gitignore 所在目录（开头的 `/` 只是锚定标记）
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globBody(line);
    if (!body) continue;
    rules.push({
      negate,
      dirOnly,
      test: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`),
    });
  }
  return rules;
}

/** 单条路径在某一组规则下的判定：true=忽略 / false=被取反捞回 / null=没有规则命中 */
function matchRules(rules, relPath, isDir) {
  let verdict = null;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.test.test(relPath)) verdict = !r.negate;
  }
  return verdict;
}

/**
 * 按 .gitignore 规则算出该跳过哪些路径。
 *
 * @param {string[]} names 相对路径（已经剥掉选中目录那一级）
 * @param {Array<{dir:string, rules:Array}>} gitignores 每个 .gitignore 的所在目录（'' 表示根）
 * @returns {Set<string>} 要跳过的路径
 */
export function applyGitignore(names, gitignores) {
  const ignored = new Set();
  const usable = gitignores.filter((g) => g && g.rules?.length);
  if (!usable.length) return ignored;

  for (const name of names) {
    if (!name) continue;
    const segs = name.split('/');
    // 逐级前缀判：目录被忽略 → 它下面的一切都忽略
    for (let i = 1; i <= segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      const isDir = i < segs.length; // 最后一段是文件（目录本身不会出现在文件清单里）
      let verdict = null;
      let matched = false;
      for (const gi of usable) {
        if (gi.dir && gi.dir !== p && !p.startsWith(gi.dir + '/')) continue; // 这份管不到 p
        const rel = gi.dir ? p.slice(gi.dir.length + 1) : p;
        const v = matchRules(gi.rules, rel, isDir);
        if (v !== null) {
          verdict = v; // 深/后匹配者覆盖
          matched = true;
        }
      }
      if (matched && verdict) {
        ignored.add(name);
        break;
      }
    }
  }
  return ignored;
}
