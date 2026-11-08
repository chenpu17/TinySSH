// r5-B 独立确认员探针：复刻 tmux-wall.tsx 的 ansiToHtml，量逐字符 escHtml 成本，
// 并做「按 span 批量转义」等价性 property test。只读源码语义，不改任何源文件。
"use strict";

// ---- 以下与 ui/src/components/tmux-wall.tsx @11b56cd 逐行同源 ----
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const palette256 = (n) => {
  if (n < 16) return `var(--ansi-${n})`;
  if (n < 232) {
    const v = n - 16;
    const step = (i) => (i === 0 ? 0 : 55 + i * 40);
    return `rgb(${step(Math.floor(v / 36))},${step(Math.floor((v % 36) / 6))},${step(v % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
};

const CSI_OTHER = /\x1b[[0-9;?]*[A-Za-z]/g;

const ansiToHtml = (text) => {
  let out = "";
  const s = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false };
  let span = "";
  const flush = () => {
    if (!span) return;
    const css = sgrCss(s);
    out += css ? `<span style="${css}">${span}</span>` : span;
    span = "";
  };
  const sgrCss = (s) => {
    let css = "";
    let fg = s.fg, bg = s.bg;
    if (s.reverse) { const t = fg; fg = bg; bg = t; }
    if (fg) css += `color:${fg};`;
    if (bg) css += `background:${bg};`;
    if (s.bold) css += "font-weight:700;";
    if (s.dim) css += "opacity:0.6;";
    if (s.italic) css += "font-style:italic;";
    if (s.underline && s.strike) css += "text-decoration:underline line-through;";
    else if (s.underline) css += "text-decoration:underline;";
    else if (s.strike) css += "text-decoration:line-through;";
    return css;
  };
  const plain = text.replace(/\r/g, "").replace(CSI_OTHER, (m) => (m.endsWith("m") ? m : ""));
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === "\x1b" && plain[i + 1] === "[") {
      const end = plain.indexOf("m", i + 2);
      if (end > 0) {
        flush();
        const codes = plain.slice(i + 2, end).split(";").map((x) => parseInt(x || "0", 10));
        for (let j = 0; j < codes.length; j++) {
          const c = codes[j];
          if (c === 0) { s.fg = null; s.bg = null; s.bold = s.dim = s.italic = s.underline = s.strike = s.reverse = false; }
          else if (c === 1) s.bold = true;
          else if (c === 2) s.dim = true;
          else if (c === 3) s.italic = true;
          else if (c === 4) s.underline = true;
          else if (c === 7) s.reverse = true;
          else if (c === 9) s.strike = true;
          else if (c === 22) { s.bold = false; s.dim = false; }
          else if (c === 23) s.italic = false;
          else if (c === 24) s.underline = false;
          else if (c === 29) s.strike = false;
          else if (c === 39) s.fg = null;
          else if (c === 49) s.bg = null;
          else if (c >= 30 && c <= 37) s.fg = palette256(c - 30);
          else if (c >= 90 && c <= 97) s.fg = palette256(c - 90 + 8);
          else if (c >= 40 && c <= 47) s.bg = palette256(c - 40);
          else if (c >= 100 && c <= 107) s.bg = palette256(c - 100 + 8);
          else if (c === 38 || c === 48) {
            const isFg = c === 38;
            if (codes[j + 1] === 5) {
              const col = palette256(codes[j + 2] ?? 0);
              j += 2;
              if (isFg) s.fg = col; else s.bg = col;
            } else if (codes[j + 1] === 2) {
              const col = `rgb(${codes[j + 2] ?? 0},${codes[j + 3] ?? 0},${codes[j + 4] ?? 0})`;
              j += 4;
              if (isFg) s.fg = col; else s.bg = col;
            }
          }
        }
        i = end;
        continue;
      }
    }
    if (ch === "\n") { flush(); out += "\n"; continue; }
    span += escHtml(ch);
  }
  flush();
  return out;
};

// ---- 候选修复形态：span 攒原文，flush 时一次性转义 ----
const escHtmlBatch = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ansiToHtmlBatch = (text) => {
  let out = "";
  const s = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, reverse: false };
  let span = "";
  const flush = () => {
    if (!span) return;
    const css = sgrCss(s);
    out += css ? `<span style="${css}">${escHtmlBatch(span)}</span>` : escHtmlBatch(span);
    span = "";
  };
  const sgrCss = (s) => {
    let css = "";
    let fg = s.fg, bg = s.bg;
    if (s.reverse) { const t = fg; fg = bg; bg = t; }
    if (fg) css += `color:${fg};`;
    if (bg) css += `background:${bg};`;
    if (s.bold) css += "font-weight:700;";
    if (s.dim) css += "opacity:0.6;";
    if (s.italic) css += "font-style:italic;";
    if (s.underline && s.strike) css += "text-decoration:underline line-through;";
    else if (s.underline) css += "text-decoration:underline;";
    else if (s.strike) css += "text-decoration:line-through;";
    return css;
  };
  const plain = text.replace(/\r/g, "").replace(CSI_OTHER, (m) => (m.endsWith("m") ? m : ""));
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === "\x1b" && plain[i + 1] === "[") {
      const end = plain.indexOf("m", i + 2);
      if (end > 0) {
        flush();
        const codes = plain.slice(i + 2, end).split(";").map((x) => parseInt(x || "0", 10));
        for (let j = 0; j < codes.length; j++) {
          const c = codes[j];
          if (c === 0) { s.fg = null; s.bg = null; s.bold = s.dim = s.italic = s.underline = s.strike = s.reverse = false; }
          else if (c === 1) s.bold = true;
          else if (c === 2) s.dim = true;
          else if (c === 3) s.italic = true;
          else if (c === 4) s.underline = true;
          else if (c === 7) s.reverse = true;
          else if (c === 9) s.strike = true;
          else if (c === 22) { s.bold = false; s.dim = false; }
          else if (c === 23) s.italic = false;
          else if (c === 24) s.underline = false;
          else if (c === 29) s.strike = false;
          else if (c === 39) s.fg = null;
          else if (c === 49) s.bg = null;
          else if (c >= 30 && c <= 37) s.fg = palette256(c - 30);
          else if (c >= 90 && c <= 97) s.fg = palette256(c - 90 + 8);
          else if (c >= 40 && c <= 47) s.bg = palette256(c - 40);
          else if (c >= 100 && c <= 107) s.bg = palette256(c - 100 + 8);
          else if (c === 38 || c === 48) {
            const isFg = c === 38;
            if (codes[j + 1] === 5) {
              const col = palette256(codes[j + 2] ?? 0);
              j += 2;
              if (isFg) s.fg = col; else s.bg = col;
            } else if (codes[j + 1] === 2) {
              const col = `rgb(${codes[j + 2] ?? 0},${codes[j + 3] ?? 0},${codes[j + 4] ?? 0})`;
              j += 4;
              if (isFg) s.fg = col; else s.bg = col;
            }
          }
        }
        i = end;
        continue;
      }
    }
    if (ch === "\n") { flush(); out += "\n"; continue; }
    span += ch;
  }
  flush();
  return out;
};

// ---- 帧合成：htop 风格（每行若干 SGR 切换 + 条形图块）与纯文本两种 ----
const makeFrame = (cols, rows, rich) => {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c += 8) {
      if (rich && c % 32 === 0) line += `\x1b[38;5;${(r + c) % 256}m`;
      if (rich && c % 64 === 0) line += `\x1b[1;${r % 2 ? "4" : "7"}m`;
      line += rich ? "|" .repeat(0) + "|||||||"[0].repeat(7).replace(/./g, (m, i2) => (i2 % 2 ? "\x1b" : "")) || "" : "";
      line += (rich ? "[|||corpus" : "plain li").slice(0, 7);
      line += "&<>x";
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
};
const frame80x24 = makeFrame(80, 24, true);
const frame200x64 = makeFrame(200, 64, true);
const plain80x24 = makeFrame(80, 24, false);
const plain200x64 = makeFrame(200, 64, false);

const bench = (label, fn, input, iters) => {
  fn(input); fn(input); // warmup
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(input);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / iters;
  console.log(`${label}: ${ms.toFixed(3)} ms/frame (${input.length} chars)`);
  return ms;
};

console.log("== node", process.version, "==");
bench("现行(逐字符esc) 80x24 rich ", ansiToHtml, frame80x24, 200);
bench("现行(逐字符esc) 80x24 plain", ansiToHtml, plain80x24, 200);
bench("现行(逐字符esc) 200x64 rich", ansiToHtml, frame200x64, 100);
bench("批量(flush转义) 80x24 rich ", ansiToHtmlBatch, frame80x24, 200);
bench("现行(逐字符esc) 200x64 plain", ansiToHtml, plain200x64, 100);
bench("批量(flush转义) 200x64 rich", ansiToHtmlBatch, frame200x64, 100);
bench("批量(flush转义) 200x64 plain", ansiToHtmlBatch, plain200x64, 100);

// ---- 等价性 property test：随机 ANSI 流，逐字符 vs 批量必须逐字节相等 ----
let bad = 0;
for (let seed = 0; seed < 500; seed++) {
  let s = "";
  const n = 1 + Math.floor(Math.random() * 4000);
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    if (r < 0.12) s += `\x1b[${Math.random() < 0.5 ? "38;5;" + Math.floor(Math.random() * 256) : String(1 + Math.floor(Math.random() * 10))}m`;
    else if (r < 0.16) s += `\x1b[${Math.floor(Math.random() * 200)}H`; // 非 SGR CSI（应剥除）
    else if (r < 0.20) s += "\n";
    else if (r < 0.24) s += "\r";
    else if (r < 0.40) s += "&";
    else if (r < 0.56) s += "<";
    else if (r < 0.72) s += ">";
    else s += String.fromCharCode(32 + Math.floor(Math.random() * 95));
  }
  const a = ansiToHtml(s);
  const b = ansiToHtmlBatch(s);
  if (a !== b) { bad++; if (bad <= 3) console.log("MISMATCH seed", seed, JSON.stringify(s.slice(0, 120)), "\n A:", JSON.stringify(a.slice(0, 160)), "\n B:", JSON.stringify(b.slice(0, 160))); }
}
console.log(bad === 0 ? "equivalence: 500/500 随机流逐字节相等 —— 批量转义等价" : `equivalence: ${bad}/500 MISMATCH`);
process.exit(bad === 0 ? 0 : 1);
