// 回归测试：导出的完整链路 —— 按钮接线 → 排版 → canvas 绘制 → 触发下载 / 复制。
//
// 跑法（在项目根目录）：
//   node tests/export-flow.test.js
//
// 为什么要单独一个文件：
//   仅测 buildImagePlan 的排版（exporter.test.js）会留下一个盲区 ——
//   app.js 里 Exporter 只在「点击」时才被引用，所以就算函数名拼错、方法名写错，
//   其他测试也照样全绿。这里用一个 canvas 桩把「真正画一遍」这条路走通，
//   能抓住「方法不存在 / 参数写错 / 没走到下载」这类问题。
//
//   canvas 桩不能验证「好不好看」（颜色、间距、字体渲染）—— 那只能真机看。
//   它能验证的是：绘制过程不抛错、画布尺寸算对了、确实调用了 fillText、确实触发了下载。

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const DIR = path.join(__dirname, "..");
const EXPECTED_WIDTH = 720; // exporter.js 的默认画布逻辑宽度

// ---- DOM 桩 ----
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], _value: "", className: "", title: "", hidden: false,
    href: "", download: "", style: {}, onclick: null, clicked: 0, disabled: false,
    addEventListener() {}, focus() {}, select() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    click() { this.clicked++; },
    get value() { return this._value; }, set value(v) { this._value = v; },
  };
  el.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._inner || ""; }, set(v) { this._inner = v; this.children = []; },
  });
  Object.defineProperty(el, "textContent", {
    get() { return this._text || ""; }, set(v) { this._text = String(v); },
  });
  return el;
}

// ---- canvas 桩：记录调用，供断言 ----
const canvasLog = { width: 0, height: 0, texts: [], scales: [], fills: 0, strokes: 0 };
function makeCanvas() {
  const c2d = {
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 0, textBaseline: "",
    scale(sx, sy) { canvasLog.scales.push([sx, sy]); },
    fillRect() { canvasLog.fills++; },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arcTo() {},
    fill() {}, stroke() { canvasLog.strokes++; },
    fillText(t, x, y) { canvasLog.texts.push({ t: String(t), x, y }); },
    measureText(t) { return { width: String(t).length * 16 }; },
  };
  return {
    get width() { return canvasLog.width; }, set width(v) { canvasLog.width = v; },
    get height() { return canvasLog.height; }, set height(v) { canvasLog.height = v; },
    getContext: (kind) => (kind === "2d" ? c2d : null),
    toBlob: (cb) => cb({ size: 2048, type: "image/png" }),
  };
}

const elCache = {};
const body = makeEl("body");
const anchors = [];   // 记录被创建的 <a>，用来验证「确实触发了下载」
const document = {
  body,
  getElementById(id) { return (elCache[id] = elCache[id] || makeEl("div")); },
  createElement(t) {
    if (t === "canvas") return makeCanvas();
    const e = makeEl(t);
    if (t === "a") anchors.push(e);
    return e;
  },
  execCommand() { return true; },
};

const store = { diary_app_api_key: "fake-key" };
const localStorage = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; },
};

let clipboardText = null;
const navigator = { clipboard: { writeText: async (t) => { clipboardText = t; } } };

const createdUrls = [];
const revokedUrls = [];
const URL = {
  createObjectURL(b) { createdUrls.push(b); return "blob:fake-url"; },
  revokeObjectURL(u) { revokedUrls.push(u); },
};

const RESPONSE_DIARY =
  '{"title":"军训第二天","content":"今天站军姿站到腿软。","mood":"疲惫","keywords":["军训","室友"]}';
const PROFILE_RESPONSE = '{"identity":"学生","summary":"还行"}';
const fetch = async (url, opt) => {
  const reqBody = JSON.parse(opt.body);
  const isGen = reqBody.messages.some((m) => m.role === "user" && m.content === "请现在生成日记。");
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: isGen ? RESPONSE_DIARY : PROFILE_RESPONSE }, finish_reason: "stop" }],
    }),
  };
};

// 假计时器：exporter.js 用 setTimeout 延迟回收 blob URL。
// 用真计时器的话，要么得真等 2 秒、要么同步断言直接抓不到（会变成一条假失败）。
// 换成可手动 flush 的假实现，既能量到「延迟多久」，也能验证「确实执行了」。
const timers = [];
const setTimeoutStub = (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; };
const clearTimeoutStub = () => {};

const window = { devicePixelRatio: 3 };
const ctx = {
  document, localStorage, fetch, console, confirm: () => true,
  Date, JSON, Math, RegExp, Array, Object, String, Number,
  setTimeout: setTimeoutStub, clearTimeout: clearTimeoutStub,
  navigator, URL, window,
};
vm.createContext(ctx);

// 加载顺序与 index.html 保持一致（exporter.js 在 app.js 之前）
let code = "";
for (const f of ["config.js", "store.js", "api.js", "styles.js", "mystyle.js", "profile.js", "exporter.js", "app.js"]) {
  code += fs.readFileSync(path.join(DIR, f), "utf8") + "\n";
}
code = code.replace(/\}\)\(\);\s*$/,
  "; globalThis.__T = { generateDiary, saveDiaryImage, copyDiaryText };" +
  " globalThis.__setMessages = (m) => { messages = m; };" +
  "})();");
code += "\n;globalThis.__B = { Exporter, Store };";
vm.runInContext(code, ctx, { filename: "bundle.js" });

const T = ctx.__T;
const { Exporter, Store } = ctx.__B;
const el = (id) => ctx.document.getElementById(id);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}

(async () => {
  console.log("=== 接线 ===\n");
  assert("bundle 里 Exporter 可用（加载顺序正确）", typeof Exporter === "object" && !!Exporter.buildImagePlan);
  assert("「存为图片」按钮绑了处理函数", typeof el("saveImageBtn").onclick === "function");
  assert("「复制文字」按钮绑了处理函数", typeof el("copyTextBtn").onclick === "function");

  // 模拟 index.html 里的初始状态（<div id="diaryActions" hidden>）
  el("diaryActions").hidden = true;

  console.log("\n=== 还没有日记时的兜底 ===\n");
  await T.saveDiaryImage();
  assert("没日记就点存图片：给出提示而不是崩掉",
    el("statusLine").textContent.includes("还没有可以导出的日记"));
  assert("没日记就点存图片：一张画布都没建", canvasLog.width === 0);
  assert("没日记就点存图片：没触发下载", anchors.length === 0);

  await T.copyDiaryText();
  assert("没日记就点复制：给出提示",
    el("statusLine").textContent.includes("还没有可以复制的日记"));
  assert("没日记就点复制：没写剪贴板", clipboardText === null);

  console.log("\n=== 生成一篇后，导出按钮露出来 ===\n");
  ctx.__setMessages([
    { role: "system", content: "S" },
    { role: "assistant", content: "开场白" },
    { role: "user", content: "今天站军姿好累" },
    { role: "assistant", content: "站了多久" },
  ]);
  await T.generateDiary();

  const list = Store.getAll();
  assert("日记已生成落库（前置条件）", list.length === 1 && list[0].title === "军训第二天");
  assert("生成后导出按钮被露出来（hidden 从 true 变 false）", el("diaryActions").hidden === false);

  console.log("\n=== 走通 canvas 绘制 → 下载 ===\n");
  await T.saveDiaryImage();

  assert("状态栏报告图片已保存", el("statusLine").textContent.includes("图片已保存"));
  assert("状态栏不是错误态", !el("statusLine").className.includes("error"));

  assert("画布宽度 = 逻辑宽度 × devicePixelRatio（720×3）",
    canvasLog.width === EXPECTED_WIDTH * 3);
  assert("画布高度为正且是整倍数缩放（不会画出半像素）",
    canvasLog.height > 0 && canvasLog.height % 3 === 0);
  assert("绘制前做了 DPR 缩放（3 倍）",
    canvasLog.scales.length === 1 && canvasLog.scales[0][0] === 3 && canvasLog.scales[0][1] === 3);
  assert("先铺了背景和卡片（fillRect / fill 被调用过）", canvasLog.fills > 0);

  const drawn = canvasLog.texts.map((t) => t.t);
  assert("确实画了标题文字", drawn.includes("军训第二天"));
  assert("确实画了正文文字", drawn.includes("今天站军姿站到腿软。"));
  assert("确实画了情绪 chip", drawn.includes("疲惫"));
  assert("确实画了关键词 chip（带 #）", drawn.includes("#军训") && drawn.includes("#室友"));
  assert("确实画了日期行", drawn.some((t) => /\d{4}年\d{1,2}月\d{1,2}日/.test(t)));
  assert("画了分隔线（stroke 被调用）", canvasLog.strokes > 0);
  assert("文字都画在画布范围内（x、y 不为负）",
    canvasLog.texts.every((t) => t.x >= 0 && t.y >= 0));

  assert("生成了 blob URL", createdUrls.length === 1);
  assert("创建了 1 个下载链接", anchors.length === 1);
  assert("下载链接指向生成的 blob", anchors[0].href === "blob:fake-url");
  assert("下载被真正触发（a.click 调了 1 次）", anchors[0].clicked === 1);
  assert("文件名是「日记_日期_标题.png」", /^日记_\d{8}_军训第二天\.png$/.test(anchors[0].download));
  assert("下载后把临时链接从文档里清掉了（没留垃圾节点）", body.children.length === 0);
  assert("安排了 blob URL 回收（防内存泄漏）", timers.length === 1);
  assert("回收有延迟，避免下载还没开始链接就失效（≥1s）", timers[0] && timers[0].ms >= 1000);
  timers.forEach((t) => t.fn());
  assert("回收真的执行了，且回收的是刚才那个 URL",
    revokedUrls.length === 1 && revokedUrls[0] === "blob:fake-url");

  console.log("\n=== 复制文字 ===\n");
  await T.copyDiaryText();
  assert("状态栏报告已复制", el("statusLine").textContent.includes("已复制"));
  assert("剪贴板内容含标题", clipboardText && clipboardText.includes("军训第二天"));
  assert("剪贴板内容含正文", clipboardText && clipboardText.includes("今天站军姿站到腿软。"));
  assert("剪贴板内容含情绪与关键词",
    clipboardText && clipboardText.includes("疲惫") && clipboardText.includes("#军训"));
  assert("剪贴板内容不含原始对话（按需求「都不带」）",
    clipboardText && !clipboardText.includes("站军姿好累") && !clipboardText.includes("开场白"));

  console.log("\n=== 失败时不能静默 ===\n");
  // 让 canvas 不支持 2d，模拟极端环境
  const realCreate = document.createElement;
  document.createElement = (t) => {
    if (t === "canvas") return { getContext: () => null, toBlob() {} };
    return realCreate(t);
  };
  await T.saveDiaryImage();
  assert("canvas 不可用时：报错而不是假装成功",
    el("statusLine").textContent.includes("导出图片失败") && el("statusLine").className.includes("error"));
  assert("canvas 不可用时：按钮恢复可用（不会卡在禁用态）", el("saveImageBtn").disabled === false);
  document.createElement = realCreate;

  console.log("\n结果：" + pass + " PASS / " + fail + " FAIL");
  process.exitCode = fail ? 1 : 0;
})();
