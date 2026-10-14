// 回归测试：图片导出的排版计算（exporter.js 的纯函数部分）。
//
// 跑法（在项目根目录）：
//   node tests/exporter.test.js
//
// 为什么只能测到这里：canvas 绘制需要真实浏览器（Node 里没有 canvas）。
// 所以本测试锁住「排版算得对不对」——换行、溢出、高度、边界。
// 「好不好看」验证不了，只能靠真机看 —— 这条边界不遮掩。
//
// 设计上能这么测，是因为 exporter.js 把 buildImagePlan(diary, measure) 做成了纯函数，
// 文字宽度由外部注入的 measure 决定。测试里注入一个「按字号算宽度」的假测量函数，
// 布局结果就完全可预测。

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const DIR = path.join(__dirname, "..");

const ctx = { console, Date, Math, JSON, RegExp, Array, Object, String, Number };
vm.createContext(ctx);
// exporter.js 的 IIFE 在定义期不碰任何 DOM/浏览器 API，所以只补个 globalThis 挂钩即可
let code = fs.readFileSync(path.join(DIR, "exporter.js"), "utf8");
code += "\n;globalThis.__E = Exporter;";
vm.runInContext(code, ctx, { filename: "exporter.js" });

const E = ctx.__E;
const { wrapText, buildImagePlan, diaryToText, safeFileName, PADDING, MARGIN, LINE_HEIGHTS } = E;

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}

// 假测量：中文字符宽度 ≈ 字号，够用来验证布局约束
function fakeMeasure(text, font) {
  const m = /(\d+)px/.exec(font || "");
  const size = m ? Number(m[1]) : 16;
  return String(text).length * size;
}
const charMeasure = (perChar) => (text) => String(text).length * perChar;

// 卡片内的可用宽度（正文/标题能用的最大宽度）
function innerWidth(plan) {
  return plan.card.x + plan.card.w - PADDING - plan.date.x;
}

console.log("=== wrapText：换行 ===");
{
  const lines = wrapText("一二三四五六七八九十一二三四五", 100, charMeasure(10));
  assert("超宽文本被拆成 2 行", lines.length === 2);
  assert("第一行正好排满 10 字", lines[0] === "一二三四五六七八九十");
  assert("第二行是剩下的 5 字", lines[1] === "一二三四五");

  const none = wrapText("短", 100, charMeasure(10));
  assert("不超宽就保持 1 行", none.length === 1 && none[0] === "短");

  const multi = wrapText("第一段\n第二段", 1000, charMeasure(10));
  assert("显式换行被保留", multi.length === 2 && multi[0] === "第一段" && multi[1] === "第二段");

  const blank = wrapText("a\n\nb", 1000, charMeasure(10));
  assert("空行被保留（3 行，中间为空串）", blank.length === 3 && blank[1] === "");

  const empty = wrapText("", 100, charMeasure(10));
  assert("空文本返回 1 个空行而不是抛错", empty.length === 1 && empty[0] === "");

  const nullish = wrapText(null, 100, charMeasure(10));
  assert("null 不抛错", Array.isArray(nullish));

  // 关键边界：单字比容器还宽时，不能死循环
  const huge = wrapText("abc", 5, () => 1000);
  assert("单字超宽时不死循环，每字一行", huge.length === 3);
}

console.log("\n=== wrapParagraph：中文禁则（避头尾）===");
{
  const m = charMeasure(10);
  // 「，回头一看」这种行首标点是渲染出图后才发现的，原来完全没覆盖。
  // 每行 5 字，第 6 个字符正好是标点 → 触发悬挂
  const comma = E.wrapParagraph("一二三四五，六七八九十", 50, m);
  assert("逗号不出现在行首", comma.every((l) => l[0] !== "，"));
  assert("逗号被悬挂在上一行尾（5 字 + 逗号）", comma[0] === "一二三四五，");
  assert("悬挂后仍能接上后面的字", comma[1] === "六七八九十");

  const period = E.wrapParagraph("你好。再见。", 20, m); // 每行 2 字
  assert("句号不落在行首", period.every((l) => l[0] !== "。"));
  assert("短行也照常悬挂", period[0] === "你好。");

  const plain = E.wrapParagraph("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥", 60, m);
  assert("无标点的纯文字换行行为不变", plain.length === 4 && plain[0] === "甲乙丙丁戊己");

  // 连续标点必须一起挂到同一行，否则「」会落到下一行行首，等于没修
  const run = E.wrapParagraph("一二三四五。」六七八九十", 50, m);
  assert("连续标点一起悬挂", run[0] === "一二三四五。」");
  assert("连标的第二个也不落行首", run.slice(1).every((l) => l[0] !== "」"));

  // 开括号/引号不能孤零零留在行尾
  const open = E.wrapParagraph("一二三四五（六七八九十", 50, m);
  assert("行尾不留开括号（挪到下一行）", open[0] === "一二三四五" && open[1][0] === "（");

  // 悬挂有上限：标点扎堆时不能一路顶出卡片
  const pileSrc = "一二三四五，。、；六七八";
  const pile = E.wrapParagraph(pileSrc, 50, m);
  const over = Math.max(...pile.map((l) => m(l))) - 50;
  assert("标点扎堆时悬挂量被上限截住", over <= E.MAX_HANGING_PUNCT * 10);
  assert("被截住的标点顺延到下一行（不丢字、不改字）", pile.join("") === pileSrc);
  assert("行首标点尽量少（极端输入下最多 1 行妥协）",
    pile.filter((l) => l[0] === "、" || l[0] === "；").length <= 1);
}

console.log("\n=== buildImagePlan：尺寸与溢出 ===");
{
  const short = { title: "累", content: "今天挺累的。", mood: "疲惫", keywords: ["军训", "室友"], createdAt: Date.now() };
  const long = {
    title: "今天真的非常非常累但是也挺开心的一件事",
    content: "早上六点就起来了。".repeat(40),
    mood: "疲惫", keywords: ["军训", "室友", "食堂", "晚自习", "手机没电了", "想家"],
    createdAt: Date.now(),
  };

  const pShort = buildImagePlan(short, fakeMeasure);
  const pLong = buildImagePlan(long, fakeMeasure);

  assert("宽度就是设定值 720", pShort.width === 720 && pLong.width === 720);
  assert("高度为正数", pShort.height > 0 && pLong.height > 0);
  assert("卡片在画布内（左右各留外边距）",
    pShort.card.x === MARGIN && pShort.card.x + pShort.card.w === pShort.width - MARGIN);
  assert("卡片高度 = 画布高 - 上下外边距",
    pShort.card.h === pShort.height - MARGIN * 2);

  assert("内容变长，图跟着变高", pLong.height > pShort.height);

  // 所有文字行都不能超出内容宽度 —— 这是排版最核心的正确性
  const iw = innerWidth(pShort);
  const titleOk = pShort.title.lines.every((l) => fakeMeasure(l, E.FONTS.title) <= iw);
  const bodyOkShort = pShort.body.lines.every((l) => fakeMeasure(l, E.FONTS.body) <= iw);
  // 悬挂标点会让某行最多超出版心「MAX_HANGING_PUNCT 个字宽」（中文避头尾的代价，见 exporter.js）。
  // 所以这里不是「一律不溢出」，而是「最多悬挂这么多，且永远不越过卡片边缘」——
  // 后者才是真正要守的红线。
  const FONT_SIZE = 18; // 正文字号，与 exporter.js 的 F.body 对齐
  const HANG_TOLERANCE = E.MAX_HANGING_PUNCT * FONT_SIZE;
  const cardRightInner = pLong.card.x + pLong.card.w;
  const bodyOkLong = pLong.body.lines.every((l) => fakeMeasure(l, E.FONTS.body) <= iw + HANG_TOLERANCE);
  const bodyInsideCard = pLong.body.lines.every(
    (l) => pLong.body.x + fakeMeasure(l, E.FONTS.body) <= cardRightInner);
  assert("短篇：标题不溢出内容宽度", titleOk);
  assert("短篇：正文不溢出内容宽度", bodyOkShort);
  assert("长篇：正文每行不超出版心 + 悬挂余量", bodyOkLong);
  // 设计不变量：悬挂总量必须小于卡片内边距，否则悬挂就会顶到卡片边缘
  assert("悬挂余量 < 卡片内边距（这是「绝不越界」的依据）", HANG_TOLERANCE < PADDING);
  assert("长篇：每一行的墨迹都在卡片之内", bodyInsideCard);
  assert("长篇正文被拆成多行", pLong.body.lines.length > 1);

  // chip 也不能溢出
  const chipRight = pShort.card.x + pShort.card.w - PADDING;
  assert("chip 不超出卡片右边界", pShort.chips.items.every((c) => c.x + c.w <= chipRight));
  assert("chip 不超出卡片右边界（关键词多、会换行的情况）",
    pLong.chips.items.every((c) => c.x + c.w <= chipRight));
  assert("chip 换行数 > 1（关键词多时）", pLong.chips.rows > 1);
  // 情绪和关键词必须在同一个流动布局里。分两组排会让情绪独占一行、关键词另起一行，
  // 白白多占一行高度 —— 第一版就是这样，是渲染出来看图才发现的。
  assert("情绪与关键词同行流动（短篇只占 1 行）", pShort.chips.rows === 1);
  assert("情绪 chip 排在关键词前面", pShort.chips.items[0].text === "疲惫");
  assert("情绪 chip 带 highlight 标记（绘制时用实心色）", pShort.chips.items[0].highlight === true);
  assert("关键词 chip 不带 highlight 标记", pShort.chips.items.slice(1).every((c) => !c.highlight));

  // 竖向顺序：日期 → 标题 → chip → 分隔线 → 正文 → 页脚，不能叠在一起
  const lastTitleY = pShort.title.firstY + (pShort.title.lines.length - 1) * LINE_HEIGHTS.title;
  assert("日期在标题之上", pShort.date.y < pShort.title.firstY);
  assert("分隔线在标题之下", pShort.divider.y > lastTitleY);
  assert("正文在分隔线之下", pShort.body.firstY > pShort.divider.y);
  assert("页脚在正文之下", pShort.foot.y > pShort.body.firstY);
  assert("页脚不出卡片下边界",
    pShort.foot.y + LINE_HEIGHTS.foot / 2 <= pShort.card.y + pShort.card.h);
}

console.log("\n=== buildImagePlan：缺字段 / 极端输入 ===");
{
  const bare = buildImagePlan({ title: "", content: "", createdAt: Date.now() }, fakeMeasure);
  assert("没标题时会补「无题」", bare.title.lines.join("") === "无题");
  assert("没情绪、没关键词时不生成 chip", bare.chips.items.length === 0);
  assert("极端空内容也不崩，高度仍为正", bare.height > 0);

  const noTime = buildImagePlan({ title: "T", content: "C" }, fakeMeasure);
  assert("没有 createdAt 也不崩（回落到当前时间）", typeof noTime.date.text === "string" && noTime.date.text.length > 0);

  const dirtyKw = buildImagePlan(
    { title: "T", content: "C", mood: "  ", keywords: ["", "  ", "有效", null] },
    fakeMeasure
  );
  assert("空情绪 / 空关键词被过滤掉", dirtyKw.chips.items.length === 1 && dirtyKw.chips.items[0].text === "#有效");
}

console.log("\n=== layoutBody：段落间距 ===");
{
  const { layoutBody, PARAGRAPH_GAP } = E;
  const m = charMeasure(10);
  const LHbody = LINE_HEIGHTS.body;

  // 关键：单个换行也算段落边界。
  // 人在手机上写日记，段与段之间就是一个换行，不会特意敲两个 ——
  // 第一版只认「空行」，于是完全没生效，五段正文糊成一整块。
  const two = layoutBody("第一段\n第二段", 1000, m);
  assert("单个换行也算段落边界", two.rows.length === 2);
  assert("段落间距 = 行高 + PARA_GAP", two.rows[1].y - two.rows[0].y === LHbody + PARAGRAPH_GAP);

  // 段落「内部」自动换行的间距必须还是纯行高 —— 有对比才看得出段落
  const wrapped = layoutBody("一二三四五六七八九十一二三四五", 100, m); // 10 字/行
  assert("段内自动换行拆成 2 行", wrapped.rows.length === 2);
  assert("段内换行间距 = 纯行高（不被撑大）", wrapped.rows[1].y - wrapped.rows[0].y === LHbody);
  assert("段间间距 > 段内间距（读者能区分）",
    (two.rows[1].y - two.rows[0].y) > (wrapped.rows[1].y - wrapped.rows[0].y));

  // 连续换行、首尾换行不该多留白，否则模型多打一个回车就多一大块空白
  const blanks = layoutBody("\n\n第一段\n\n\n第二段\n\n", 1000, m);
  assert("连续换行 / 首尾换行不产生额外行", blanks.rows.length === 2);
  assert("空行不改变段落间距", blanks.rows[1].y - blanks.rows[0].y === LHbody + PARAGRAPH_GAP);

  const indented = layoutBody("  第一段  \n\t第二段", 1000, m);
  assert("段首段尾空白被清掉", indented.rows[0].text === "第一段" && indented.rows[1].text === "第二段");

  const emptyBody = layoutBody("", 1000, m);
  assert("空正文 → 0 行、不抛错", emptyBody.rows.length === 0 && emptyBody.height === 0);

  assert("高度 = 最后一行中线 + 半行高（不多不少）",
    two.height === two.rows[two.rows.length - 1].y + LHbody / 2);

  // 长段落 + 多个段落混排：所有行都要在内容宽度内
  const mixed = layoutBody(("中文".repeat(30)) + "\n" + ("字".repeat(50)), 200, m); // 20 字/行
  assert("多段混排时每行都不溢出宽度", mixed.rows.every((r) => r.text.length <= 20));
}

console.log("\n=== buildImagePlan：正文行坐标 ===");
{
  const d = { title: "T", content: "第一段\n第二段", createdAt: Date.now() };
  const p = buildImagePlan(d, fakeMeasure);
  assert("body.rows 与 body.lines 一一对应", p.body.rows.length === 2 && p.body.lines.length === 2);
  assert("rows 的 y 是绝对坐标（落在卡片内）",
    p.body.rows.every((r) => r.y > p.body.top && r.y < p.card.y + p.card.h));
  assert("body.firstY 就是首行 y（绘制与旧断言都对齐）", p.body.firstY === p.body.rows[0].y);
  assert("首行中线 = 正文区顶部 + 半行高", p.body.rows[0].y === p.body.top + LINE_HEIGHTS.body / 2);

  const onePara = buildImagePlan(
    { title: "T", content: "第一段第二段", createdAt: Date.now() }, fakeMeasure);
  assert("分段会让图变高（段落间距确实吃掉了高度）", p.height > onePara.height);

  const noBody = buildImagePlan({ title: "只有标题", content: "", createdAt: Date.now() }, fakeMeasure);
  assert("正文为空时 rows 为空，但 firstY 仍然可用（绘制不炸）",
    noBody.body.rows.length === 0 && typeof noBody.body.firstY === "number");
  assert("正文为空时页脚仍在正文区之下", noBody.foot.y > noBody.body.top);
}

console.log("\n=== diaryToText / safeFileName ===");
{
  const t = diaryToText({ title: "标题", content: "正文内容", mood: "平静", keywords: ["a", "b"], createdAt: Date.now() });
  assert("纯文字含标题", t.includes("标题"));
  assert("纯文字含正文", t.includes("正文内容"));
  assert("纯文字含情绪与关键词", t.includes("平静") && t.includes("#a") && t.includes("#b"));

  assert("文件名清掉非法字符", safeFileName('a/b\\c:d*e?f"g<h>i|j') === "abcdefghij");
  assert("文件名清掉空白", safeFileName("今天 很 累") === "今天很累");
  assert("标题为空时回落到「日记」", safeFileName("") === "日记");
  assert("超长标题被截断到 20 字", safeFileName("啊".repeat(50)).length === 20);
}

console.log("\n=== 不碰浏览器 API（脚本加载期安全）===");
{
  assert("exporter.js 在无 document / window / navigator 的环境下能加载完成",
    typeof E.buildImagePlan === "function" && typeof E.exportImage === "function");
  // 上面整个 vm 上下文里没有 document、window、navigator，
  // 能跑到这里就说明 IIFE 定义期确实没碰它们 —— 这是「页面不白屏」的保障。
}

console.log("\n结果：" + pass + " PASS / " + fail + " FAIL");
process.exitCode = fail ? 1 : 0;
