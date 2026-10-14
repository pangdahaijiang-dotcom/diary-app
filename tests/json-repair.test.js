// 回归测试：模型返回的 JSON 被截断 / 不规范时，extractJson 能否救回。
//
// 跑法（在项目根目录）：
//   node tests/json-repair.test.js
//
// 背景：曾经出现过「日记 JSON 解析失败：Unterminated string in JSON at position 315」，
// 原因是模型输出被截断（撞 max_tokens 或传输被切）。这里的用例锁住当时的两种失败模式：
//   1) 字符串/数组未闭合 → repairJson 补齐后仍能解析（能救）
//   2) 字符串内部出现未转义的英文双引号 → 无法用补括号救回，改由 Prompt 层面禁止（救不了，必须报错）
//
// 说明：这是个「无头」测试——用 Node 的 vm 把浏览器端脚本跑在桩环境里，
// 不需要开浏览器、不需要 API Key（fetch 被替换成假响应）。

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const DIR = path.join(__dirname, "..");

function makeClassList(el) {
  return {
    toggle(n, f) {
      const s = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      const should = f === undefined ? !s.has(n) : !!f;
      if (should) s.add(n); else s.delete(n);
      el.className = [...s].join(" ");
      return should;
    },
    add(n) { this.toggle(n, true); }, remove(n) { this.toggle(n, false); },
    contains(n) { return String(el.className || "").split(/\s+/).includes(n); },
  };
}

function makeEl(tag) {
  const el = {
    tagName: tag, children: [], _value: "", className: "", title: "", hidden: false,
    scrollTop: 0, scrollHeight: 0, style: {}, onclick: null,
    addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    remove() {}, focus() {},
    get value() { return this._value; }, set value(v) { this._value = v; },
  };
  el.classList = makeClassList(el);
  Object.defineProperty(el, "innerHTML", {
    get() { return this._inner || ""; }, set(v) { this._inner = v; this.children = []; },
  });
  Object.defineProperty(el, "textContent", {
    get() { return this._text || ""; }, set(v) { this._text = String(v); },
  });
  return el;
}

const elCache = {};
const document = {
  getElementById(id) { return (elCache[id] = elCache[id] || makeEl("div")); },
  createElement(t) { return makeEl(t); },
};

const store = { diary_app_api_key: "fake-key" };
const localStorage = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};

let RESPONSE = "";
const fetch = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: RESPONSE }, finish_reason: "stop" }] }),
});

const ctx = {
  document, localStorage, fetch, console, confirm: () => true,
  Date, JSON, Math, RegExp, Array, Object, String, Number, setTimeout, clearTimeout,
};
vm.createContext(ctx);

// 把所有浏览器脚本串成一个 bundle，在同一个作用域里跑（模拟 index.html 的加载顺序）
let code = "";
for (const f of ["config.js", "store.js", "api.js", "styles.js", "mystyle.js", "profile.js", "exporter.js", "app.js"]) {
  code += fs.readFileSync(path.join(DIR, f), "utf8") + "\n";
}
// app.js 是 IIFE，内部变量取不出来 → 在收尾处把要测的函数挂到 globalThis
code = code.replace(/\}\)\(\);\s*$/,
  "; globalThis.__T = { generateDiary, extractJson, repairJson };" +
  " globalThis.__setMessages = (m) => { messages = m; };" +
  "})();");
code += "\n;globalThis.__Store = Store;";
vm.runInContext(code, ctx, { filename: "bundle.js" });

const T = ctx.__T;
const Store = ctx.__Store;
const el = (id) => ctx.document.getElementById(id);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}
function tryParse(s) { try { return T.extractJson(s); } catch (e) { return { __err: e.message }; } }

(async () => {
  // ---- 1. 正常情况 ----
  const ok = tryParse('{"title":"T","content":"正文","mood":"平静","keywords":["a"]}');
  assert("完整 JSON 正常解析", ok && ok.title === "T" && ok.keywords[0] === "a");

  // ---- 2. 截断：字符串未闭合 ----
  const cut1 = tryParse('{"title":"军训第二天","content":"今天改得还算顺，就是费时');
  assert("截断（字符串未闭合）能修补", cut1 && cut1.title === "军训第二天" && cut1.content.includes("费时"));

  // ---- 3. 截断：数组 + 字符串都没闭合 ----
  const cut2 = tryParse('{"title":"T","content":"x","keywords":["a","b');
  assert("截断（数组+字符串未闭合）能修补", cut2 && cut2.keywords.length === 2);

  // ---- 4. 未转义的英文引号：补括号救不了，必须清晰报错（靠 Prompt 规避）----
  const cut3 = tryParse('{"title":"T","content":"他说"好"就完了');
  assert("未转义英文引号 → 明确报错（改由 prompt 规避）",
    cut3 && cut3.__err && cut3.__err.includes("解析失败"));

  // ---- 5. 正确转义的引号，不能误伤花括号计数 ----
  const ok2 = tryParse('{"content":"他说\\"{好}\\"就完了"}');
  assert("字符串内含花括号不影响计数", ok2 && ok2.content.includes("{好}"));

  // ---- 6. 带 markdown 代码块围栏 + 截断 ----
  const fenced = tryParse('```json\n{"title":"F","content":"被截断的正文');
  assert("带代码块围栏的截断也能修补", fenced && fenced.title === "F");

  // ---- 7. 断点位置的各种边界：同样是「被截断」，但断在不同地方 ----
  const cutComma = tryParse('{"title":"T","content":"x",');
  assert("截断在逗号后（字段之间）也能修补", cutComma && cutComma.title === "T" && cutComma.content === "x");

  const cutArrComma = tryParse('{"title":"T","keywords":["a","b",');
  assert("截断在数组内逗号后：最后一项不丢", cutArrComma && cutArrComma.keywords.length === 2);

  const cutColon = tryParse('{"title":"T","content":');
  assert("截断在冒号后（值没写）不产出非法 JSON", cutColon && cutColon.title === "T");

  const cutKey = tryParse('{"title":"T","content"');
  assert("截断在键名后：残字段整个丢弃", cutKey && cutKey.title === "T" && cutKey.content === undefined);

  const cutBackslash = tryParse('{"title":"T","content":"x\\');
  assert("截断在孤立反斜杠上也能修补", cutBackslash && cutBackslash.content === "x");

  // ---- 8. 正文里含 } 时，找结尾不能切错位置 ----
  // 旧实现用 lastIndexOf("}")，会把正文里的 } 当成 JSON 结尾，
  // 跟在后面的字段会被整段丢掉 —— 这里锁住修复效果。
  const braceTrunc = tryParse('{"title":"A","content":"写了{好}这个字","mood":"平');
  assert("正文含花括号 + 截断在其后：内容与后续字段都不丢",
    braceTrunc && braceTrunc.content === "写了{好}这个字" && braceTrunc.mood === "平");

  const withProse = tryParse('{"title":"A","content":"写了{好}这个字"} 希望你喜欢这篇');
  assert("完整 JSON + 尾部解释文字：能切干净", withProse && withProse.content === "写了{好}这个字");

  // ---- 8'. 正文里的换行转义（提示词要求 content 用 \n 分段，导出图片靠它分段落）----
  // 这条链路是「提示词要求 → 解析 → 导出排版」的连接点，断了的话
  // 导出图片会把整篇糊成一整块（layoutBody 拿不到真换行）。
  const withNewline = tryParse('{"title":"N","content":"第一段\\n第二段","mood":"平"}');
  assert("换行转义能还原成真换行", withNewline && withNewline.content === "第一段\n第二段");
  assert("还原后确实是 2 段（导出排版有段落可排）",
    withNewline && withNewline.content.split("\n").filter(Boolean).length === 2);

  const cutEscape = tryParse('{"title":"N","content":"第一段\\n第二段\\');
  assert("截断在换行转义的反斜杠上：前面的换行与内容都保留",
    cutEscape && cutEscape.content === "第一段\n第二段");

  // ---- 9. 完全不是 JSON ----
  const bad = tryParse("这根本不是 JSON，模型在胡说");
  assert("彻底不是 JSON → 抛清晰错误", bad && bad.__err && bad.__err.includes("解析失败"));

  // ---- 10. 端到端：截断响应下，整条生成流程仍应成功 ----
  ctx.__setMessages([
    { role: "system", content: "S" },
    { role: "assistant", content: "开场白" },
    { role: "user", content: "今天挺累的" },
    { role: "assistant", content: "怎么个累法" },
  ]);
  RESPONSE = '{"title":"截断标题","content":"正文写到一半就断';
  await T.generateDiary();

  const st = el("statusLine").textContent;
  assert("截断响应下不再报解析失败", !st.includes("解析失败"));
  assert("状态栏显示生成完成", st.includes("生成完成"));

  const list = Store.getAll();
  assert("截断的日记仍被存进 localStorage", list.length === 1 && list[0].title === "截断标题");
  assert("截断的正文被完整保留到断点", list[0].content === "正文写到一半就断");

  // renderDiary 是 diaryBox.innerHTML="" 之后 appendChild(card)，
  // 所以渲染结果在 children 里，card 自身的 innerHTML 才是 HTML 串。
  const dbox = el("diaryBox");
  const rendered = dbox.children.some((c) => String(c._inner || "").includes("截断标题"));
  assert("日记框已渲染且卡片含标题", rendered);

  console.log("\n结果：" + pass + " PASS / " + fail + " FAIL");
  process.exitCode = fail ? 1 : 0;
})();
