#!/usr/bin/env node
/**
 * 用法:
 *   node sourcemap-locate.mjs <生成.js> <行> <列> [--root <工程根>]
 *   node sourcemap-locate.mjs <生成.js>:<行>:<列>  [--root <工程根>]
 *
 * 行、列均为1-based。
 * 特例：当行=1 且列超出第1行长度时，列被视为文件级字符偏移（0-based），
 *       自动换算为实际 (行, 列) 再查 source map。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { root: null, jsPath: null, line: null, col: null };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1]) {
      args.root = resolve(argv[++i]);
    } else if (!a.startsWith("-")) {
      positional.push(a);
    }
  }

  if (positional.length >= 3) {
    // 传统格式: <js> <行> <列>
    args.jsPath = positional[0];
    args.line   = parseInt(positional[1], 10);
    args.col    = parseInt(positional[2], 10);
  } else if (positional.length >= 1) {
    // 一体格式: <js>:<行>:<列>  （Mac 路径不含冒号，最后两段取数字即可）
    const parts = positional[0].split(":");
    if (parts.length >= 3) {
      const col  = parseInt(parts[parts.length - 1], 10);
      const line = parseInt(parts[parts.length - 2], 10);
      if (Number.isFinite(line) && Number.isFinite(col)) {
        args.jsPath = parts.slice(0, parts.length - 2).join(":");
        args.line   = line;
        args.col    = col;
      }
    }
  }
  return args;
}

/**
 * 将文件级字符偏移（0-based）转换为 1-based 行号 + 0-based 列号。
 * 支持 \r\n / \r / \n 三种换行。
 */
function globalOffsetToLineCol(content, offset0) {
  const before = content.slice(0, offset0);
  const lines  = before.split(/\r\n|\r|\n/);
  return { line: lines.length, col0: lines[lines.length - 1].length };
}

function extractSourceMappingURL(js) {
  const m = js.match(/\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/);
  return m ? m[1].trim() : null;
}

function loadMap(jsPath, jsContent) {
  const url = extractSourceMappingURL(jsContent);
  if (!url) {
    throw new Error("未在 JS 末尾找到 //# sourceMappingURL=");
  }
  if (/^data:/i.test(url)) {
    throw new Error("暂不支持 inline data: source map");
  }
  const base = dirname(resolve(jsPath));
  const mapPath = isAbsolute(url) ? url : resolve(base, url);
  if (!existsSync(mapPath)) {
    throw new Error(`找不到 source map文件: ${mapPath}`);
  }
  const raw = readFileSync(mapPath, "utf8");
  return { mapPath, mapJson: JSON.parse(raw) };
}

function normalizeLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function tryReadSourceFromDisk(sourcePath, root) {
  const candidates = [];
  if (root) candidates.push(join(root, sourcePath));
  candidates.push(resolve(process.cwd(), sourcePath));
  for (const p of candidates) {
    if (existsSync(p)) {
      return normalizeLines(readFileSync(p, "utf8"));
    }
  }
  return null;
}

function printContext({ sourcePath, line1, col0, lines, contentOrigin }) {
  const CONTEXT = 3;
  const idx = line1 - 1;
  if (idx < 0 || idx >= lines.length) {
    console.error("源文件行号超出范围");
    process.exit(1);
  }
  const start = Math.max(0, idx - CONTEXT);
  const end = Math.min(lines.length - 1, idx + CONTEXT);

  const originLabel =
    contentOrigin === "inline"
      ? "（源码来自 source map 内联 sourcesContent，非磁盘文件）"
      : "（源码来自磁盘）";
  console.log(`源文件: ${sourcePath}`);
  console.log(originLabel);
  console.log(`位置: 第 ${line1} 行, 第 ${col0 + 1} 列 (1-based 列)\n`);

  const width = String(end + 1).length;

  for (let i = start; i <= end; i++) {
    const n = i + 1;
    const prefix = `${String(n).padStart(width, " ")}: `;
    console.log(prefix + lines[i]);
    if (n === line1) {
      const pad = " ".repeat(prefix.length + col0) + "^";
      console.log(pad);
    }
  }
}

function usage() {
  console.error(`用法:
  node sourcemap-locate.mjs <生成.js> <行> <列> [--root <工程根>]
  node sourcemap-locate.mjs <生成.js>:<行>:<列>  [--root <工程根>]

  行、列: 均1-based（相对生成后的 .js 文件）
  特例:   行=1 且列超出第1行长度时，列视为文件级字符偏移量，自动换算。

  --root  仅当 map 未携带对应 sourcesContent 时，用于从磁盘读取 .ts`);
}

async function main() {
  const { root, jsPath: rawJsPath, line: rawLine, col: rawCol } = parseArgs(process.argv);
  if (!rawJsPath || !Number.isFinite(rawLine) || !Number.isFinite(rawCol)) {
    usage();
    process.exit(1);
  }

  if (rawLine < 1 || rawCol < 1) {
    console.error("行、列须为 >=1 的整数");
    process.exit(1);
  }

  const jsPath    = resolve(rawJsPath);
  const jsContent = readFileSync(jsPath, "utf8");

  // 当 line=1 且列号超出第1行长度时，将列号视为文件级字符偏移量
  const jsLines   = jsContent.split(/\r\n|\r|\n/);
  let genLine, genCol0;
  if (rawLine === 1 && rawCol - 1 > jsLines[0].length) {
    const converted = globalOffsetToLineCol(jsContent, rawCol - 1);
    genLine  = converted.line;
    genCol0  = converted.col0;
    console.log(`[偏移模式] 字符偏移 ${rawCol - 1} → 第 ${genLine} 行, 第 ${genCol0 + 1} 列（JS 文件内）`);
  } else {
    genLine = rawLine;
    genCol0 = rawCol - 1;
  }

  const { mapJson } = loadMap(jsPath, jsContent);

  const consumer = await new SourceMapConsumer(mapJson);
  try {
    const pos = consumer.originalPositionFor({
      line: genLine,
      column: genCol0,
    });

    if (pos.source == null || pos.line == null || pos.column == null) {
      console.error("该 (行, 列) 在 source map 中没有映射（可能落在无映射的运行时代码上）。");
      process.exit(2);
    }

    /** 只要 map 里有 sourcesContent，就用官方 API 取内联 TS，避免路径不一致时误读盘 */
    const inline = consumer.sourceContentFor(pos.source, true);
    let lines = null;
    let contentOrigin = "disk";
    if (inline != null && inline !== "") {
      lines = normalizeLines(inline);
      contentOrigin = "inline";
    } else {
      lines = tryReadSourceFromDisk(pos.source, root);
    }
    if (!lines) {
      console.error(
        `无法取得源码内容: ${pos.source}\n若 map 无内联内容，请传入 --root 指向含 assets/TypeScript 的工程根目录。`
      );
      process.exit(3);
    }

    printContext({
      sourcePath: pos.source,
      line1: pos.line,
      col0: pos.column,
      lines,
      contentOrigin,
    });
  } finally {
    consumer.destroy();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
