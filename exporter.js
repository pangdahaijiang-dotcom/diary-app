// exporter.js —— 把一篇日记导出成「可以分享的图片」，以及导出纯文字到剪贴板
//
// 为什么单独一个文件：app.js 的职责是「读配置 + 拼装 + 渲染」，
// 导出涉及的排版计算与 canvas 绘制是另一件事，塞进 app.js 会把它撑成杂物间。
//
// 关键设计：把「排版计算」和「绘制」分开
//   · buildImagePlan(diary, measure, opts) —— 纯计算，返回一张"施工图"（尺寸 + 每块文字的位置）
//     measure 由外部注入，所以这个函数能在 Node 里无头测试（见 tests/exporter.test.js）
//   · exportImage(diary) —— 按施工图用 canvas 真画出来并下载
//   这样「逻辑对不对」可以自动验证，「好不好看」只能靠真机看 —— 这条边界是诚实的。
//
// 样式沿用 app 的绿色配色（见 style.css 的 :root），保证导出的图和界面是一套语言。

const Exporter = (() => {
  // ---- 配色（与 style.css 的 :root 保持一致）----
  const C = {
    bg: "#F8F5EE",       // 温暖纸色
    card: "#FFFFFF",
    text: "#5C563F",     // DRAGON
    muted: "#A39E84",
    accent: "#6F8E5A",   // 主按钮橄榄绿
    chipBg: "#DDE7CF",   // 浅 sage
    divider: "#DBDEC9",
  };

  const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';
  const F = {
    date: "400 15px " + FONT_FAMILY,
    title: "500 30px " + FONT_FAMILY,
    body: "400 18px " + FONT_FAMILY,
    chip: "400 14px " + FONT_FAMILY,
    foot: "400 13px " + FONT_FAMILY,
  };
  // 行高（canvas 不自动排版，行高要自己算）
  // body 用 32（字号 18 的约 1.78 倍）。关键取舍：行内别放太松，
  // 段落之间的分隔靠 PARA_GAP 拉开 —— 只把行距调大，段落会糊成一片，反而更难看懂。
  const LH = { date: 22, title: 43, body: 32, chip: 30, foot: 20 };
  const PARA_GAP = 13;  // 正文段落之间的额外间距
  const PAD = 42;   // 卡片内边距
  const M = 26;     // 画布外边距

  // ---- 纯函数区：这些不碰 canvas，可在 Node 里测 ----

  // 中文排版禁则：这些标点不能出现在行首（否则「，回头一看」这种断法很难看）。
  // canvas 逐字换行不会自己处理，得手动做 —— 行首出现标点，是渲染出来看图才发现的。
  const NO_LINE_START = "，。、；：！？）」』】》〉…—～·%!?,.;:)]}";
  // 相对的：这些不能出现在行尾（不然「（」孤零零挂在行尾）
  const NO_LINE_END = "（「『【《〈([{";
  // 一行最多允许悬挂几个标点。
  // 为什么要有上限：「……」「。」「！？」这类连续标点会一直被挂上去，
  // 遇上标点扎堆的行会一路顶出卡片。上限 2 足够覆盖中文里真实出现的连标，
  // 且 2 个字宽（36px）< 卡片内边距 PAD（42px）→ 绝不越过卡片边缘。
  const MAX_HANG = 2;

  // 中文友好的逐字换行（单段）。
  // 已知取舍：纯英文的单词可能被从中间断开（比如 "hello" 断成 "hel" / "lo"）。
  // 日记正文以中文为主，逐字换行对中文是最准的；为英文单独写断词逻辑收益不大。
  //
  // 禁则两条，用「悬挂标点 + 回拉」实现：
  //   · 该断的地方正好是个不能起头的标点 → 让它挂在上一行末尾出去
  //     （代价：该行最多超出 maxWidth 两个字宽，由卡片内边距兜住）
  //   · 该断时行尾是「（」这类 → 把它一起挪到下一行，而不是孤零零留在行尾
  function wrapParagraph(para, maxWidth, measure) {
    const out = [];
    let line = "";
    let hangLeft = 0; // 刚吐出的那行还能再接几个悬挂标点（连标用）

    for (const ch of para) {
      const mustHang = NO_LINE_START.indexOf(ch) >= 0;

      // ① 刚吐出的那行还等着接标点：连续标点一起挂过去
      if (hangLeft > 0 && mustHang) { out[out.length - 1] += ch; hangLeft--; continue; }

      // ② 行首为空时无论如何先收下 —— 也保证「单字比容器还宽」时不死循环
      if (!line) { line = ch; hangLeft = 0; continue; }

      if (measure(line + ch) <= maxWidth) { line += ch; continue; }

      // ③ 放不下了
      if (mustHang && MAX_HANG > 0) {
        out.push(line + ch); // 标点悬挂到行尾
        line = "";
        hangLeft = MAX_HANG - 1;
        continue;
      }
      const last = line[line.length - 1];
      if (line.length > 1 && NO_LINE_END.indexOf(last) >= 0) {
        out.push(line.slice(0, -1)); // 开引号/括号跟着下一行走
        line = last + ch;
      } else {
        out.push(line);
        line = ch;
      }
      hangLeft = 0;
    }
    if (line) out.push(line);
    return out;
  }

  // 把多段文本摊平成「行」的数组，空段落保留为空串（标题用它，标题不需要段落间距）
  function wrapText(text, maxWidth, measure) {
    const out = [];
    const paras = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    for (const para of paras) {
      if (!para) { out.push(""); continue; }
      out.push(...wrapParagraph(para, maxWidth, measure));
    }
    return out;
  }

  // 正文排版：把换行当「段落边界」，段落之间额外拉开 PARA_GAP。
  //
  // 为什么要专门写这个，而不是拿 wrapText 的结果按「第 i 行 × 行高」定位：
  // 第一版就是那样写的，结果「自动换行产生的行」和「真正的段落边界」间距完全一样，
  // 五段正文糊成一整块，读者分不清哪儿是段落。这是渲染出来看图才发现的 ——
  // 纯逻辑断言抓不到「看起来糊」这种问题。
  //
  // 空段落（连续换行）直接跳过、不额外留白，否则模型多打一个换行就多出一大块空白。
  // 返回的 y 是每行的「中线」坐标（绘制时 textBaseline = "middle"）。
  function layoutBody(text, maxWidth, measure) {
    const paras = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    const rows = [];
    let y = 0;
    let started = false;
    for (const para of paras) {
      const p = para.trim();
      if (!p) continue;
      if (started) y += PARA_GAP; // 段落之间额外拉开
      started = true;
      for (const line of wrapParagraph(p, maxWidth, measure)) {
        y += LH.body;
        rows.push({ text: line, y: y - LH.body / 2 });
      }
    }
    return { rows, height: y };
  }

  // 把 chip（情绪 + 关键词）排成若干行，返回绝对坐标（方便测试直接断言不溢出）。
  // 入参既接受字符串，也接受 { text, highlight } —— 情绪和关键词必须放在同一个流动布局里，
  // 否则情绪会独占一行、关键词另起一行，白白多占一行高度（第一版就是这样，看图才发现的）。
  const CHIP_PAD_X = 14; // chip 左右内边距，绘制时也用这个值
  function layoutChips(chips, originX, originY, maxWidth, measure) {
    const chipH = LH.chip;
    const gapX = 10;
    const gapY = 10;
    const items = [];
    let x = 0;
    let row = 0;
    for (const c of chips) {
      const isStr = typeof c === "string";
      const text = isStr ? c : c.text;
      const highlight = isStr ? false : !!c.highlight;
      const w = measure(text) + CHIP_PAD_X * 2;
      if (x > 0 && x + w > maxWidth) { x = 0; row++; }
      items.push({
        text,
        x: originX + x,
        centerY: originY + row * (chipH + gapY) + chipH / 2,
        w: w,
        h: chipH,
        padX: CHIP_PAD_X,
        highlight,
      });
      x += w + gapX;
    }
    const rows = items.length ? row + 1 : 0;
    return { items, rows, height: rows ? rows * chipH + (rows - 1) * gapY : 0 };
  }

  function formatDate(ts) {
    const d = ts ? new Date(ts) : new Date();
    const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd}`;
  }

  // 施工图：算出图多大、每块内容画在哪。
  // measure(text, font) → 文字宽度（像素）。真机传 canvas 的测量函数，测试传 mock。
  function buildImagePlan(diary, measure, opts) {
    opts = opts || {};
    const W = opts.width || 720;
    const cardX = M;
    const cardW = W - M * 2;
    const contentX = cardX + PAD;
    const innerW = cardW - PAD * 2;

    const title = String((diary && diary.title) || "无题");
    const content = String((diary && diary.content) || "");
    const mood = diary && diary.mood ? String(diary.mood).trim() : "";
    const keywords = ((diary && diary.keywords) || [])
      .map((k) => String(k == null ? "" : k).trim())
      .filter(Boolean)
      .map((k) => "#" + k);

    const titleLines = wrapText(title, innerW, (t) => measure(t, F.title));
    const bodyLayout = layoutBody(content, innerW, (t) => measure(t, F.body));

    // 光标式排版：从上往下累加，避免手写一堆魔法数字
    let y = M + PAD;

    const accent = { x: contentX, y: y + 5, w: 46, h: 5, r: 2.5, fill: C.accent };
    y += 5 + 5 + 16;

    const date = { x: contentX, y: y + LH.date / 2, text: formatDate(diary && diary.createdAt), font: F.date, color: C.muted };
    y += LH.date + 10;

    const titleBlock = { x: contentX, firstY: y + LH.title / 2, lines: titleLines, font: F.title, color: C.text };
    y += titleLines.length * LH.title + 18;

    // 情绪 chip 用实心强调色、关键词 chip 用浅色，视觉上区分开。
    // 但两者放在同一个流动布局里 —— 情绪不该独占一行。
    const chipDefs = [];
    if (mood) chipDefs.push({ text: mood, highlight: true });
    keywords.forEach((k) => chipDefs.push({ text: k }));

    let chips = { items: [], rows: 0, height: 0 };
    if (chipDefs.length) {
      chips = layoutChips(chipDefs, contentX, y, innerW, (t) => measure(t, F.chip));
      y += chips.height + 16;
    }

    const divider = { x1: contentX, x2: contentX + innerW, y: y, color: C.divider };
    y += 1 + 26;

    // 正文：rows 里已经是「绝对中线坐标」，段落之间的间距在 layoutBody 里就拉好了。
    // lines 保留一份纯文本数组，方便测试直接断言「每行都不溢出」。
    const bodyTop = y;
    const bodyRows = bodyLayout.rows.map((r) => ({ text: r.text, y: r.y + bodyTop }));
    const bodyBlock = {
      x: contentX,
      top: bodyTop,
      firstY: bodyRows.length ? bodyRows[0].y : bodyTop + LH.body / 2,
      rows: bodyRows,
      lines: bodyRows.map((r) => r.text),
      font: F.body,
      color: C.text,
    };
    y += bodyLayout.height + 30;

    const foot = { x: contentX, y: y + LH.foot / 2, text: "日记挖掘伙伴 · 由对话整理", font: F.foot, color: C.muted };
    y += LH.foot + PAD;

    const height = Math.round(y + M); // 加上底部外边距

    return {
      width: W,
      height: height,
      colors: C,
      card: { x: cardX, y: M, w: cardW, h: height - M * 2, r: 28, fill: C.card },
      accent,
      date,
      title: titleBlock,
      chips,
      divider,
      body: bodyBlock,
      foot,
    };
  }

  // 纯文字版（给「复制文字」用）
  function diaryToText(diary) {
    const parts = [];
    parts.push(String((diary && diary.title) || "无题"));
    parts.push(formatDate(diary && diary.createdAt));
    const mood = diary && diary.mood ? String(diary.mood).trim() : "";
    const kws = ((diary && diary.keywords) || []).filter(Boolean);
    if (mood || kws.length) {
      parts.push([mood, kws.map((k) => "#" + k).join(" ")].filter(Boolean).join("  "));
    }
    parts.push("");
    parts.push(String((diary && diary.content) || ""));
    return parts.join("\n");
  }

  // ---- 绘制区：以下必须真浏览器（Node 里没有 canvas）----

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function safeFileName(s) {
    return String(s == null ? "" : s)
      .replace(/[\\/:*?"<>|\r\n\t]/g, "")
      .replace(/\s+/g, "")
      .slice(0, 20) || "日记";
  }

  // 真正导出：返回 { fileName, blob }
  async function buildImageBlob(diary, opts) {
    const dpr = Math.max(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持 canvas，无法导出图片。");

    // 先测量（只依赖 ctx.font，与画布尺寸无关）
    const measure = (text, font) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    const plan = buildImagePlan(diary, measure, opts);

    canvas.width = Math.round(plan.width * dpr);
    canvas.height = Math.round(plan.height * dpr);
    ctx.scale(dpr, dpr);            // 放大画布 + 缩放坐标系 = 高清输出
    ctx.textBaseline = "middle";

    ctx.fillStyle = plan.colors.bg;
    ctx.fillRect(0, 0, plan.width, plan.height);

    ctx.fillStyle = plan.card.fill;
    roundRect(ctx, plan.card.x, plan.card.y, plan.card.w, plan.card.h, plan.card.r);
    ctx.fill();

    ctx.fillStyle = plan.accent.fill;
    roundRect(ctx, plan.accent.x, plan.accent.y, plan.accent.w, plan.accent.h, plan.accent.r);
    ctx.fill();

    ctx.font = plan.date.font;
    ctx.fillStyle = plan.date.color;
    ctx.fillText(plan.date.text, plan.date.x, plan.date.y);

    ctx.font = plan.title.font;
    ctx.fillStyle = plan.title.color;
    plan.title.lines.forEach((ln, i) => {
      if (ln) ctx.fillText(ln, plan.title.x, plan.title.firstY + i * LH.title);
    });

    plan.chips.items.forEach((c) => {
      ctx.fillStyle = c.highlight ? C.accent : C.chipBg;
      roundRect(ctx, c.x, c.centerY - c.h / 2, c.w, c.h, c.h / 2);
      ctx.fill();
      ctx.font = F.chip;
      ctx.fillStyle = c.highlight ? "#FFFFFF" : C.text;
      ctx.fillText(c.text, c.x + c.padX, c.centerY);
    });

    ctx.strokeStyle = plan.divider.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plan.divider.x1, plan.divider.y + 0.5);
    ctx.lineTo(plan.divider.x2, plan.divider.y + 0.5);
    ctx.stroke();

    ctx.font = plan.body.font;
    ctx.fillStyle = plan.body.color;
    // 逐行用「绝对 y」画：段落间距已经算在 rows[i].y 里了，不能再乘行高
    plan.body.rows.forEach((r) => ctx.fillText(r.text, plan.body.x, r.y));

    ctx.font = plan.foot.font;
    ctx.fillStyle = plan.foot.color;
    ctx.fillText(plan.foot.text, plan.foot.x, plan.foot.y);

    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("生成图片失败（canvas.toBlob 没有返回数据）。");

    const d = diary && diary.createdAt ? new Date(diary.createdAt) : new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return { blob, fileName: `日记_${stamp}_${safeFileName(diary && diary.title)}.png` };
  }

  // 触发浏览器下载
  async function exportImage(diary, opts) {
    const { blob, fileName } = await buildImageBlob(diary, opts);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    // 部分浏览器要求 a 在文档里才会响应 click()
    if (document.body && document.body.appendChild) {
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else {
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return fileName;
  }

  // 复制纯文字到剪贴板（优先用新 API，失败退回旧办法）
  async function copyText(text) {
    const s = String(text == null ? "" : text);
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(s);
        return true;
      } catch (e) {
        // 非 https / 无权限时会抛错，继续走下面的降级方案
      }
    }
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (!ok) throw new Error("复制失败，请手动选中文字复制。");
    return true;
  }

  return {
    // 纯函数（可在 Node 里测）
    wrapText,
    wrapParagraph,
    layoutBody,
    layoutChips,
    formatDate,
    diaryToText,
    buildImagePlan,
    safeFileName,
    // 需要真浏览器
    buildImageBlob,
    exportImage,
    copyText,
    // 常量，方便测试与调用方对齐
    FONTS: F,
    LINE_HEIGHTS: LH,
    PARAGRAPH_GAP: PARA_GAP,
    MAX_HANGING_PUNCT: MAX_HANG,
    NO_LINE_START,
    NO_LINE_END,
    PADDING: PAD,
    MARGIN: M,
  };
})();
