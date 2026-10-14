// 回归测试：编辑日记（改标题 / 正文 / 情绪 / 标签）。
//
// 跑法（在项目根目录）：
//   node tests/edit-diary.test.js
//
// 这个功能最容易出的不是「界面点不动」，而是「改完之后别处还是旧的」——
// 具体说：currentDiary 忘了同步，编辑看着成功，但「存为图片」导出的还是改之前的内容。
// 所以本文件不满足于断言"Store 里更新了"，而是**真跑一遍导出**，看画布上画出来的字是不是新的。
//
// 无头运行：Node vm + DOM/canvas 桩，不开浏览器、不用 API Key。

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const DIR = path.join(__dirname, "..");

// ---- DOM 桩 ----
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
    checked: false, disabled: false, href: "", download: "", style: {}, onclick: null,
    clicked: 0, scrollTop: 0, scrollHeight: 0,
    addEventListener() {}, focus() { this.focused = true; }, select() {}, remove() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    click() { this.clicked++; },
    get value() { return this._value; }, set value(v) { this._value = String(v); },
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

// ---- canvas 桩：记下"到底画了哪些字"，这是验证导出用没用新内容的唯一办法 ----
const canvasLog = { width: 0, height: 0, texts: [] };
function makeCanvas() {
  const c2d = {
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 0, textBaseline: "",
    scale() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {},
    lineTo() {}, arcTo() {}, fill() {}, stroke() {},
    fillText(t) { canvasLog.texts.push(String(t)); },
    measureText(t) { return { width: String(t).length * 16 }; },
  };
  return {
    get width() { return canvasLog.width; }, set width(v) { canvasLog.width = v; },
    get height() { return canvasLog.height; }, set height(v) { canvasLog.height = v; },
    getContext: (k) => (k === "2d" ? c2d : null),
    toBlob: (cb) => cb({ size: 1024, type: "image/png" }),
  };
}

const elCache = {};
const document = {
  body: makeEl("body"),
  getElementById(id) { return (elCache[id] = elCache[id] || makeEl("div")); },
  createElement(t) {
    if (t === "canvas") return makeCanvas();
    return makeEl(t);
  },
  execCommand() { return true; },
};

const store = { diary_app_api_key: "fake-key" };
const localStorage = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};

let fetchCount = 0;
const RESPONSE_DIARY =
  '{"title":"军训第二天","content":"今天站军姿站到腿软。","mood":"疲惫","keywords":["军训","室友"]}';
const PROFILE_RESPONSE = '{"identity":"学生","summary":"还行"}';
const fetch = async (url, opt) => {
  fetchCount++;
  const isGen = JSON.parse(opt.body).messages.some(
    (m) => m.role === "user" && m.content === "请现在生成日记。"
  );
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: isGen ? RESPONSE_DIARY : PROFILE_RESPONSE }, finish_reason: "stop" }],
    }),
  };
};

const ctx = {
  document, localStorage, fetch, console, confirm: () => true,
  Date, JSON, Math, RegExp, Array, Object, String, Number,
  setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
  navigator: { clipboard: { writeText: async () => {} } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  window: { devicePixelRatio: 2 },
};
vm.createContext(ctx);

let code = "";
for (const f of ["config.js", "store.js", "api.js", "styles.js", "mystyle.js", "profile.js", "exporter.js", "app.js"]) {
  code += fs.readFileSync(path.join(DIR, f), "utf8") + "\n";
}
code = code.replace(/\}\)\(\);\s*$/,
  "; globalThis.__T = { generateDiary, saveDiaryImage, openEdit, saveEdit, closeEdit," +
  " parseKeywords, getCurrentDiary: () => currentDiary };" +
  " globalThis.__setMessages = (m) => { messages = m; };" +
  "})();");
code += "\n;globalThis.__B = { Store, Exporter };";
vm.runInContext(code, ctx, { filename: "bundle.js" });

const T = ctx.__T;
const { Store, Exporter } = ctx.__B;
const el = (id) => ctx.document.getElementById(id);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}

(async () => {
  // ================= Store.update 的语义 =================
  console.log("=== Store.update：只改该改的 ===\n");
  const a = Store.save({ title: "A", content: "A 的正文", mood: "平静", keywords: ["x"] });
  const b = Store.save({ title: "B", content: "B 的正文", mood: "开心", keywords: ["y"] });
  const aCreatedAt = a.createdAt;
  // 连着 save 两次必然落在同一毫秒 —— 正好把「id 撞车」这条不变量钉住。
  // id 是 update / remove 定位记录的唯一依据，撞了会改错篇。
  assert("同一毫秒内连存两篇也不会撞 id", a.id !== b.id);

  let upd = Store.update(a.id, { content: "改过的正文" });
  assert("更新成功返回值里是新内容", upd && upd.content === "改过的正文");
  assert("落库了（重新读取也是新内容）", Store.getAll().find((d) => d.id === a.id).content === "改过的正文");
  assert("只传了 content，其余字段保持原样（标题）", upd.title === "A");
  assert("只传了 content，其余字段保持原样（情绪 / 标签）",
    upd.mood === "平静" && upd.keywords.length === 1 && upd.keywords[0] === "x");
  assert("id 不会被 patch 覆盖", upd.id === a.id);
  assert("createdAt 不会被 patch 覆盖（改的是内容，不是「什么时候写的」）", upd.createdAt === aCreatedAt);
  assert("记下了 editedAt（数据要诚实，界面可以不显示）", typeof upd.editedAt === "number" && upd.editedAt > 0);

  const bad = Store.update("d_不存在的id", { content: "x" });
  assert("找不到 id 返回 null（调用方才能给真实提示）", bad === null);
  assert("找不到 id 时不改动任何数据", Store.getAll().length === 2);

  assert("不影响别的日记", Store.getAll().find((d) => d.id === b.id).content === "B 的正文");
  const order = Store.getAll();
  assert("更新后排序仍按时间从新到旧", order[0].createdAt >= order[1].createdAt);

  // ================= 标签解析 =================
  console.log("\n=== parseKeywords：用户不用记格式 ===\n");
  const pk = T.parseKeywords;
  assert("英文逗号分隔", JSON.stringify(pk("军训, 室友")) === JSON.stringify(["军训", "室友"]));
  assert("中文逗号 / 顿号 / 分号都能用",
    JSON.stringify(pk("军训，室友、食堂；晚自习")) === JSON.stringify(["军训", "室友", "食堂", "晚自习"]));
  assert("空格分隔也能用", pk("军训 室友").length === 2);
  assert("去掉用户手打的 #", JSON.stringify(pk("#军训 #室友")) === JSON.stringify(["军训", "室友"]));
  assert("重复标签去重", JSON.stringify(pk("军训 军训")) === JSON.stringify(["军训"]));
  assert("只有分隔符 → 空数组", pk("  ,,，  ").length === 0);
  assert("空值 / undefined 不抛错", pk("").length === 0 && pk(undefined).length === 0);
  assert("换行 / 制表符也算分隔", pk("a\tb\nc").length === 3);

  // ================= 编辑流程（端到端） =================
  console.log("\n=== 还没有日记时点编辑 ===\n");
  Store.getAll().forEach((d) => Store.remove(d.id)); // 清空，模拟全新用户
  el("diaryActions").hidden = true;
  // 桩里的元素默认 hidden=false，得手动摆成 index.html 的初始状态（<div id="editModal" hidden>），
  // 否则「弹窗没被打开」这条断言会假失败 —— 它测的是桩的默认值，不是代码行为。
  el("editModal").hidden = true;
  el("editBtn").onclick();
  assert("没日记点编辑：给提示而不是崩", el("statusLine").textContent.includes("还没有可以编辑的日记"));
  assert("没日记点编辑：弹窗不打开", el("editModal").hidden === true);

  console.log("\n=== 生成一篇后，编辑按钮可用 ===\n");
  ctx.__setMessages([
    { role: "system", content: "S" },
    { role: "assistant", content: "开场白" },
    { role: "user", content: "今天站军姿好累" },
  ]);
  await T.generateDiary();
  assert("日记已生成（前置条件）", Store.getAll().length === 1);
  assert("编辑按钮已露出", el("diaryActions").hidden === false);

  el("editBtn").onclick();
  assert("点编辑：弹窗打开", el("editModal").hidden === false);
  assert("回填标题", el("editTitle").value === "军训第二天");
  assert("回填正文", el("editContent").value === "今天站军姿站到腿软。");
  assert("回填情绪", el("editMood").value === "疲惫");
  assert("回填标签（逗号分隔、不带 #）", el("editKeywords").value === "军训, 室友");
  assert("弹窗里有实时字数/标签数提示", el("editCount").textContent.includes("正文 10 字"));
  const freshCard = el("diaryBox").children.map((c) => String(c._inner || "")).join("");
  assert("还没编辑过：卡片上不该有「已编辑」标记", !freshCard.includes("已编辑"));
  const freshHist = el("historyList").children.map((c) => String(c._inner || "")).join("");
  assert("还没编辑过：历史列表里也不该有标记", !freshHist.includes("已编辑"));

  console.log("\n=== 保存修改：库里、卡片、历史、导出都必须同步 ===\n");
  const beforeFetch = fetchCount;
  const createdBefore = Store.getAll()[0].createdAt;
  el("editTitle").value = "军训第二天（改）";
  el("editContent").value = "改后的正文。";
  el("editMood").value = "累并快乐";
  el("editKeywords").value = "#军训, 室友, 食堂, 军训"; // 手打 # + 重复，考解析
  el("editSave").onclick();

  const saved = Store.getAll()[0];
  assert("标题落库", saved.title === "军训第二天（改）");
  assert("正文落库", saved.content === "改后的正文。");
  assert("情绪落库", saved.mood === "累并快乐");
  assert("标签落库：去了 # 也去了重",
    JSON.stringify(saved.keywords) === JSON.stringify(["军训", "室友", "食堂"]));
  assert("createdAt 没被动过", saved.createdAt === createdBefore);
  assert("editedAt 写上了", typeof saved.editedAt === "number");
  assert("保存编辑不发网络请求（纯本地操作，不花 API 钱）", fetchCount === beforeFetch);
  assert("弹窗自动关闭", el("editModal").hidden === true);
  assert("状态栏反馈已保存", el("statusLine").textContent.includes("已保存你的修改"));

  const cardHtml = el("diaryBox").children.map((c) => String(c._inner || "")).join("");
  assert("卡片重渲染成新标题", cardHtml.includes("军训第二天（改）"));
  assert("卡片重渲染成新正文", cardHtml.includes("改后的正文。"));
  assert("卡片重渲染成新标签", cardHtml.includes("#食堂") && cardHtml.includes("累并快乐"));
  const histHtml = el("historyList").children.map((c) => String(c._inner || "")).join("");
  assert("历史列表标题也跟着变（不能只改一处）", histHtml.includes("军训第二天（改）"));

  console.log("\n=== 「已编辑」标记：只给界面看，不碰数据与导出 ===\n");
  const firstEditedAt = saved.editedAt;
  assert("卡片上出现「已编辑」标记", cardHtml.includes("已编辑"));
  assert("历史列表里也标了「已编辑」（一眼看出哪些是自己手改的）", histHtml.includes("已编辑"));
  assert("标记里带具体修改时间（悬停可见，不占视觉空间）",
    /title="最后修改：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}"/.test(cardHtml));
  assert("标记不会出现在标题/正文里（只是元信息那一行）",
    !saved.title.includes("已编辑") && !saved.content.includes("已编辑"));
  assert("标记不进数据（keywords / mood 里都没有）",
    !saved.mood.includes("已编辑") && !saved.keywords.join("").includes("已编辑"));

  const exportedText = Exporter.diaryToText(saved);
  assert("复制出来的文字里没有「已编辑」（界面标记 ≠ 日记内容）",
    !exportedText.includes("已编辑"));

  // 这条是本次的重点：currentDiary 没同步的话，下面这一断言会当场挂
  assert("currentDiary 已同步成新记录", T.getCurrentDiary().content === "改后的正文。");

  canvasLog.texts.length = 0;
  await T.saveDiaryImage();
  assert("编辑后导出：画布上画的是新正文（不是改之前的）",
    canvasLog.texts.includes("改后的正文。"));
  assert("编辑后导出：画布上没有旧正文", !canvasLog.texts.includes("今天站军姿站到腿软。"));
  assert("编辑后导出：画的是新标题", canvasLog.texts.includes("军训第二天（改）"));
  assert("编辑后导出：画的是新标签", canvasLog.texts.includes("#食堂"));
  assert("编辑后导出：图片里不画「已编辑」（那是界面标记，不是日记内容）",
    !canvasLog.texts.some((t) => t.includes("已编辑")));

  console.log("\n=== 校验与边界 ===\n");
  el("editBtn").onclick();
  el("editContent").value = "   ";
  el("editSave").onclick();
  assert("正文清空 → 拒绝保存并说清原因", el("statusLine").textContent.includes("正文不能为空"));
  assert("正文清空 → 数据没被改", Store.getAll()[0].content === "改后的正文。");
  assert("正文清空 → 弹窗留着不关（让用户接着改）", el("editModal").hidden === false);

  el("editTitle").value = "";
  el("editContent").value = "只有正文没有标题。";
  el("editSave").onclick();
  assert("标题清空 → 允许保存（不替用户往数据里塞「无题」）", Store.getAll()[0].title === "");
  assert("再次编辑会刷新 editedAt（不会倒退）", Store.getAll()[0].editedAt >= firstEditedAt);
  const cardHtml2 = el("diaryBox").children.map((c) => String(c._inner || "")).join("");
  assert("标题为空时界面回落显示「无题」", cardHtml2.includes("无题"));
  assert("标题为空时「已编辑」标记仍保留", cardHtml2.includes("已编辑"));

  el("editBtn").onclick();
  el("editContent").value = "这次不该被保存。";
  el("editCancel").onclick();
  assert("点取消 → 数据不变", Store.getAll()[0].content === "只有正文没有标题。");
  assert("点取消 → 弹窗关闭", el("editModal").hidden === true);

  // 弹窗开着的时候这篇被删掉了（另一个入口删的），保存不能崩
  el("editBtn").onclick();
  el("editContent").value = "谁也存不进去。";
  Store.remove(Store.getAll()[0].id);
  el("editSave").onclick();
  assert("编辑过程中日记被删 → 明确报错而不是静默失败",
    el("statusLine").textContent.includes("没找到这篇日记"));
  assert("编辑过程中日记被删 → 弹窗关掉，不留一个悬空表单", el("editModal").hidden === true);

  // ================= 顺手修掉的既有 bug =================
  console.log("\n=== 开新对话后不能留上一篇的按钮 ===\n");
  await T.generateDiary();
  assert("又生成了一篇（前置条件）", Store.getAll().length === 1);
  el("newBtn").onclick();
  assert("开新对话后：日记盒子清空", el("diaryBox").children.length === 0);
  assert("开新对话后：编辑/导出按钮收起（原来这个按钮会留着）", el("diaryActions").hidden === true);
  assert("开新对话后：currentDiary 被清掉", T.getCurrentDiary() === null);
  el("editBtn").onclick();
  assert("开新对话后点编辑：提示没有日记，而不是打开一篇看不见的旧日记",
    el("statusLine").textContent.includes("还没有可以编辑的日记") && el("editModal").hidden === true);
  canvasLog.texts.length = 0;
  await T.saveDiaryImage();
  assert("开新对话后点存图片：不会偷偷导出上一篇", canvasLog.texts.length === 0);

  console.log("\n结果：" + pass + " PASS / " + fail + " FAIL");
  process.exitCode = fail ? 1 : 0;
})();
