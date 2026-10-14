// 回归测试：「按我的文风」（纯模仿模式）的指令拼装与拦截逻辑。
//
// 跑法（在项目根目录）：
//   node tests/gen-prompt.test.js
//
// 背景：用户反馈"生成还是会被原有风格影响，做不到完全按真实文风"。
// 排查后发现污染源不止一个，加个下拉选项只是入口，真正要做的是
// 在纯模仿模式下把「预设调性 / 通用语气要求 / 内置范例」全部撤掉，
// 并点名压住两个隐藏污染源：前面对话的语气、近期日记回顾的语气。
//
// 本测试锁住三件事：
//   A. 纯模仿模式的 system 一定不含任何预设风格成分，且一定含压制指令与格式要求；
//   B. 预设风格（非 pure）的拼装行为完全没被这次改动影响（防回归）；
//   C. 选了「按我的文风」但没样本时必须拦住，不能静默按别的风格生成。
//
// 无头运行：Node vm + DOM/localStorage/fetch 桩，不开浏览器、不需要 API Key。

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

// 按请求类型分流返回：生成日记 → RESPONSE；画像抽取 → 合法画像 JSON
const PROFILE_RESPONSE = '{"identity":"学生","summary":"普普通通"}';
let RESPONSE = "";
let REQUESTS = [];
const fetch = async (url, opt) => {
  const body = JSON.parse(opt.body);
  REQUESTS.push(body);
  const isGen = body.messages.some(
    (m) => m.role === "user" && m.content === "请现在生成日记。"
  );
  const content = isGen ? RESPONSE : PROFILE_RESPONSE;
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
  };
};

const ctx = {
  document, localStorage, fetch, console, confirm: () => true,
  Date, JSON, Math, RegExp, Array, Object, String, Number, setTimeout, clearTimeout,
};
vm.createContext(ctx);

let code = "";
for (const f of ["config.js", "store.js", "api.js", "styles.js", "mystyle.js", "profile.js", "exporter.js", "app.js"]) {
  code += fs.readFileSync(path.join(DIR, f), "utf8") + "\n";
}
code = code.replace(/\}\)\(\);\s*$/,
  "; globalThis.__T = { generateDiary, extractJson, repairJson };" +
  " globalThis.__setMessages = (m) => { messages = m; };" +
  "})();");
// 顶层符号（同脚本作用域）直接挂出来给断言用
code += "\n;globalThis.__B = { buildGen, GEN_STYLES, GEN_MINE_RULES, GEN_BASE_RULES," +
  " GEN_FORMAT, GEN_EXAMPLES, CONFIG, MyStyle, Store };";
vm.runInContext(code, ctx, { filename: "bundle.js" });

const T = ctx.__T;
const B = ctx.__B;
const { buildGen, GEN_STYLES, CONFIG, MyStyle, Store } = B;
const el = (id) => ctx.document.getElementById(id);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}

// 只保留「本次生成」那一次请求，排除画像抽取请求
function genSystemPrompt() {
  const req = REQUESTS.find((r) =>
    r.messages.some((m) => m.role === "user" && m.content === "请现在生成日记。")
  );
  return req ? req.messages[0].content : "";
}

const MINE = GEN_STYLES.find((s) => s.id === "mine");
const FRAGMENT = GEN_STYLES.find((s) => s.id === "fragment");

(async () => {
  // ============ A. 纯模仿模式的指令拼装 ============
  const pure = buildGen(MINE, { withExamples: true }); // 故意传 true，验证 pure 会无视它

  assert("GEN_STYLES 里存在 mine 选项且标记 pure", !!MINE && MINE.pure === true);
  assert("mine 刻意不提供 genTwist", MINE.genTwist === undefined);

  assert("纯模仿：不含「通用要求」的语气条款", !pure.includes("少堆形容词"));
  assert("纯模仿：不含「严禁 AI 套路」整段", !pure.includes("严禁以下 AI 套路"));
  assert("纯模仿：不含内置范例", !pure.includes("例1（叙事但口语") && !pure.includes("例3（emo 但直给"));

  // 任何预设风格的调性都不能漏进来（含 withExamples:true 的情况）
  const leakedTwist = GEN_STYLES
    .filter((s) => s.genTwist)
    .filter((s) => pure.includes(s.genTwist.slice(0, 20)));
  assert("纯模仿：不注入任何预设调性（genTwist）", leakedTwist.length === 0);

  assert("纯模仿：保留「唯一语气依据」声明", pure.includes("唯一语气依据"));
  assert("纯模仿：点名压制「前面对话的语气」", pure.includes("不要模仿前面对话的语气"));
  assert("纯模仿：点名压制「近期日记回顾的语气」", pure.includes("不要模仿【近期日记回顾】的语气"));
  assert("纯模仿：保留「不得编造」硬约束", pure.includes("不得编造"));
  assert("纯模仿：保留第一人称要求", pure.includes("第一人称"));
  assert("纯模仿：保留 JSON 输出格式（机器要读）", pure.includes("【输出格式】") && pure.includes('"title"'));

  // ============ B. 预设风格行为未被影响（防回归） ============
  const preset = buildGen(FRAGMENT, {});
  assert("预设风格：仍含通用要求", preset.includes("少堆形容词"));
  assert("预设风格：仍含内置范例", preset.includes("例1（叙事但口语"));
  assert("预设风格：仍含自己的调性", preset.includes(FRAGMENT.genTwist));
  assert("预设风格：仍含 JSON 输出格式", preset.includes("【输出格式】"));

  const presetNoEx = buildGen(FRAGMENT, { withExamples: false });
  assert("预设风格 + 有样本：范例换成省略说明",
    !presetNoEx.includes("例1（叙事但口语") && presetNoEx.includes("关于语气范例"));

  // findGen 的兜底是 GEN_STYLES[0]，mine 必须不在首位，否则异常 id 会回退到无样本的 pure 项
  assert("mine 不在 GEN_STYLES 首位（保护 findGen 的兜底）", GEN_STYLES[0].id !== "mine");

  // ============ C. 端到端：选了「按我的文风」但没样本 → 必须拦住 ============
  ctx.__setMessages([
    { role: "system", content: "S" },
    { role: "assistant", content: "开场白" },
    { role: "user", content: "今天上了两节课" },
    { role: "assistant", content: "然后呢" },
  ]);
  el("genSelect").value = "mine";
  MyStyle.clear(); // 确保没有样本
  REQUESTS = [];
  RESPONSE = '{"title":"不该出现","content":"不该出现","mood":"无","keywords":[]}';

  await T.generateDiary();
  const st1 = el("statusLine").textContent;
  assert("无样本选 mine：状态栏说明是「还没粘贴」", st1.includes("还没粘贴你自己写的日记"));
  assert("无样本选 mine：状态栏是错误态", el("statusLine").className.includes("error"));
  assert("无样本选 mine：没有生成任何日记", Store.getAll().length === 0);
  assert("无样本选 mine：根本没发起生成请求", genSystemPrompt() === "");

  // 粘了样本但「生成时模仿」开关没勾 —— 最容易让人懵的一种，提示必须指向开关本身，
  // 否则用户明明看到框里有字，却被告诉"还没粘样本"。
  MyStyle.save({ text: "今天没干啥。", enabled: false });
  REQUESTS = [];
  await T.generateDiary();
  assert("粘了样本但开关没勾：提示指向开关",
    el("statusLine").textContent.includes("没勾上"));
  assert("粘了样本但开关没勾：仍然拦住不生成",
    Store.getAll().length === 0 && genSystemPrompt() === "");

  // ============ D. 端到端：有样本后正常走纯模仿 ============
  const SAMPLE_A = "今天没干啥。中午吃了碗面，肉给得挺多。";
  const SAMPLE_B = "下午睡了俩小时，醒了有点慌，也不知道慌啥。";
  MyStyle.save({ text: SAMPLE_A + "\n\n" + SAMPLE_B, enabled: true });
  assert("样本已保存且可用", MyStyle.hasUsable() === true && MyStyle.samples().length === 2);

  RESPONSE = '{"title":"我的日记","content":"正经正文","mood":"平静","keywords":["a"]}';
  REQUESTS = [];
  await T.generateDiary();

  const sys = genSystemPrompt();
  assert("端到端：确实发起了生成请求", sys !== "");
  assert("端到端：system 含本人样本 A", sys.includes(SAMPLE_A));
  assert("端到端：system 含本人样本 B", sys.includes(SAMPLE_B));
  assert("端到端：system 不含预设语气条款", !sys.includes("少堆形容词"));
  assert("端到端：system 不含内置范例", !sys.includes("例1（叙事但口语"));
  assert("端到端：system 仍保留 JSON 格式要求", sys.includes("【输出格式】"));
  assert("端到端：system 仍注入日期（跨天记忆未被破坏）", sys.includes("今天是"));

  const list = Store.getAll();
  assert("端到端：日记已落库", list.length === 1 && list[0].title === "我的日记");
  assert("端到端：记录了用的是 mine 风格", list[0].genStyleId === "mine");
  assert("端到端：状态栏显示生成完成", el("statusLine").textContent.includes("生成完成"));

  // ============ E. 样本被清空后，不能悄悄退回预设风格 ============
  MyStyle.clear();
  RESPONSE = '{"title":"也不该出现","content":"x","mood":"无","keywords":[]}';
  REQUESTS = [];
  await T.generateDiary();
  assert("样本被清空后再生成：仍被拦住",
    el("statusLine").textContent.includes("还没粘贴你自己写的日记") && genSystemPrompt() === "");
  assert("样本被清空后：日记数量没有增加", Store.getAll().length === 1);

  console.log("\n结果：" + pass + " PASS / " + fail + " FAIL");
  process.exitCode = fail ? 1 : 0;
})();
