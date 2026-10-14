// 一次跑完 tests/ 目录下所有 *.test.js 回归测试。
//
// 跑法（在项目根目录）：
//   node tests/run-all.js
//
// 这些测试都是无头的：不需要开浏览器、不需要 API Key。
// 任何逻辑类改动，先让这里全绿，再上真机验证。

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (!files.length) {
  console.log("tests/ 下没找到 *.test.js");
  process.exit(1);
}

const results = [];

for (const f of files) {
  let out = "";
  let ok = true;
  try {
    out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: "utf8" });
  } catch (e) {
    ok = false;
    out = (e.stdout || "") + (e.stderr || "");
  }
  const resLine = out.split("\n").find((l) => l.startsWith("结果")) || "(没有输出结果行)";
  results.push({ f, ok, resLine });
  console.log((ok ? "  ✓ " : "  ✗ ") + f.padEnd(28) + resLine);

  if (!ok) {
    // 失败时把具体哪几条挂了打出来，省得再单独跑一遍
    out.split("\n")
      .filter((l) => l.startsWith("FAIL"))
      .forEach((l) => console.log("        " + l));
  }
}

const bad = results.filter((r) => !r.ok);
console.log("\n" + (bad.length
  ? "有失败：" + bad.map((b) => b.f).join("、")
  : "全部通过 ✓  （" + files.length + " 个测试文件）"));
process.exitCode = bad.length ? 1 : 0;
