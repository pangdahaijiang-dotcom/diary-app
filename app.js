// app.js —— 主逻辑：对话挖掘 + 生成日记 + 历史回看
// 依赖全局：CONFIG（config.js）、Store（store.js）、Api（api.js）
(function () {
  "use strict";

  // 人设 / 生成指令 / 开场白 都搬到 styles.js（双维度风格预设），这里不再硬编码。
  // 想改语气、加风格，只动 styles.js，app.js 负责「读配置 + 拼装 + 渲染」。

  // 对话状态：messages[0] 固定为 system 人设，后面是 user/assistant 交替
  let messages = [];
  // 当前展示在"今天的日记"里的那篇 id（删除时用来判断是否要清屏）
  let currentDiaryId = null;
  // 当前展示的日记「完整记录」（导出要用到 id / createdAt，光有 id 不够）
  let currentDiary = null;

  // ---- DOM 引用 ----
  const $ = (id) => document.getElementById(id);
  const chatBox = $("chatBox");
  const userInput = $("userInput");
  const sendBtn = $("sendBtn");
  const generateBtn = $("generateBtn");
  const newBtn = $("newBtn");
  const diaryBox = $("diaryBox");
  const historyList = $("historyList");
  const apiKeyInput = $("apiKeyInput");
  const saveKeyBtn = $("saveKeyBtn");
  const keyStatus = $("keyStatus");
  const statusLine = $("statusLine");
  const convSelect = $("convSelect");
  const genSelect = $("genSelect");
  // 「我的文风」弹窗相关
  const myStyleBtn = $("myStyleBtn");
  const myStyleModal = $("myStyleModal");
  const myStyleInput = $("myStyleInput");
  const myStyleEnabled = $("myStyleEnabled");
  const myStyleCount = $("myStyleCount");
  const myStyleSave = $("myStyleSave");
  const myStyleClear = $("myStyleClear");
  const myStyleClose = $("myStyleClose");
  // 导出相关
  const diaryActions = $("diaryActions");
  const saveImageBtn = $("saveImageBtn");
  const copyTextBtn = $("copyTextBtn");
  // 编辑相关
  const editBtn = $("editBtn");
  const editModal = $("editModal");
  const editTitle = $("editTitle");
  const editContent = $("editContent");
  const editMood = $("editMood");
  const editKeywords = $("editKeywords");
  const editCount = $("editCount");
  const editSave = $("editSave");
  const editCancel = $("editCancel");

  // ---- 风格查表 / 当前选择 ----
  // 这两个下拉的选项来自 styles.js（CONV_STYLES / GEN_STYLES）。
  // 用 id 反查，找不到就退回第一个（防止旧数据/手滑出错）。
  function findConv(id) {
    return CONV_STYLES.find((s) => s.id === id) || CONV_STYLES[0];
  }
  function findGen(id) {
    return GEN_STYLES.find((s) => s.id === id) || GEN_STYLES[0];
  }
  function currentConv() {
    return findConv(convSelect.value);
  }
  function currentGen() {
    return findGen(genSelect.value);
  }

  // ---- 当前时间 / 跨天记忆 ----
  // 把"今天几号"告诉伙伴，否则它连日期都不知道（之前就是漏了这步）。
  function todayStr() {
    const d = new Date();
    const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd}`;
  }

  // 取最近 n 篇日记的简短回顾，注入给伙伴/生成，实现"跨天记忆"（阶段三）。
  // 只给日期+标题+前 100 字，避免一次性灌太多、带偏语气；且明确"仅供衔接、不编造"。
  function recentDiariesBrief(n) {
    const list = Store.getAll(); // 最新在前
    const picked = list.slice(0, n).reverse(); // 改回时间正序，方便按时间衔接
    if (!picked.length) return "";
    const lines = picked.map((d) => {
      const dt = new Date(d.createdAt);
      const day = `${dt.getMonth() + 1}月${dt.getDate()}日`;
      const snippet = (d.content || "").replace(/\s+/g, " ").slice(0, 100);
      return `- ${day}《${d.title || "无题"}》：${snippet}${snippet.length >= 100 ? "…" : ""}`;
    });
    return "【近期日记回顾（仅供你自然衔接，绝不替用户编造）】\n" + lines.join("\n");
  }

  // 把"当前时间 + 近期回顾 + 用户画像"拼到对话人设后面：
  // · 日期 → 知道今天几号
  // · 近期回顾 → 接上"发生了什么"
  // · 用户画像 → 接上"你是谁"，实现精准交互（阶段三升级）
  function buildConvSystem(conv) {
    let note = `\n\n【当前时间】今天是 ${todayStr()}。`;
    const brief = recentDiariesBrief(3);
    if (brief) note += "\n" + brief;
    const pt = Profile.toText(Profile.get());
    if (pt) note += "\n" + pt;
    return conv.system + note;
  }

  // ---- 小工具 ----
  function setStatus(msg, isError) {
    statusLine.textContent = msg || "";
    statusLine.className = "status" + (isError ? " error" : "");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "me" : "ai");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    div.appendChild(bubble);
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function showThinking() {
    const div = document.createElement("div");
    div.className = "msg ai";
    div.id = "thinking";
    div.innerHTML = '<div class="bubble">对方正在回想…</div>';
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
  function removeThinking() {
    const t = $("thinking");
    if (t) t.remove();
  }

  // 找到最外层 JSON 容器闭合的位置（正确跳过字符串内部的括号与转义引号）。
  // 返回「结束下标 + 1」；没闭合（=被截断）返回 -1。
  function findJsonEnd(s) {
    let inStr = false, esc = false, depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  // 尝试修复「被截断的 JSON」：补上未闭合的字符串，以及缺失的 ] 和 }
  // 场景：模型输出太长被截断 —— 可能断在字符串里、逗号后、冒号后、或只写了个键名。
  function repairJson(s) {
    let inStr = false, esc = false, strStart = -1, lastStruct = "";
    const stack = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; strStart = i; }
      else if (ch === "{" || ch === "[") { stack.push(ch); lastStruct = ch; }
      else if (ch === "}" || ch === "]") stack.pop();
      else if (ch === "," || ch === ":") lastStruct = ch;
    }

    let out = s;
    if (esc) out = out.slice(0, -1);   // 结尾是个孤立的反斜杠，先丢掉
    if (inStr) {
      const top = stack[stack.length - 1];
      // 断在「值」上（前面是冒号），或断在数组元素上 → 补上收尾引号，保住已有内容；
      // 只有「对象里一个键名都没写完」（冒号还没出现）才是废字段，整段丢弃。
      if (lastStruct === ":" || top === "[") out += '"';
      else out = out.slice(0, strStart);
    }

    // 反复清掉尾部「没写完」的碎片，直到不再变化：
    // 悬挂逗号（"a":1, → "a":1）/ 悬挂冒号（"a": → 删）/ 只有键名没值（,"a" → 整个字段删）
    for (;;) {
      const before = out;
      out = out.replace(/,\s*$/, "");
      out = out.replace(/:\s*$/, "");
      // 只有键名：仅当最内层容器是对象时才丢弃。
      // 数组里的字符串是「元素」，必须保留，否则会莫名其妙丢掉数组最后一项。
      if (stack[stack.length - 1] === "{") {
        out = out.replace(/([{,]\s*)"(?:[^"\\]|\\.)*"\s*$/, "$1");
      }
      if (out === before) break;
    }

    while (stack.length) {             // 再按后进先出补上没闭合的容器
      out += stack.pop() === "{" ? "}" : "]";
    }
    return out;
  }

  // 从模型返回里揪出 JSON（防它顺手包了 ```json ``` 或加了解释文字）
  function extractJson(text) {
    const raw = String(text ?? "").trim();
    if (!raw) {
      throw new Error("模型返回了空内容，可能是输出被截断或请求异常。");
    }
    let s = raw;
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1];
    const start = s.indexOf("{");
    if (start > 0) s = s.slice(start);
    // 只在「最外层容器确实闭合了」时才切掉尾部的解释文字。
    // 不能用 lastIndexOf("}")：正文里出现 } 时会切错位置，把后面的字段整段丢掉。
    const end = start >= 0 ? findJsonEnd(s) : -1;
    if (end > 0) s = s.slice(0, end);

    // 第一轮：直接解析
    try {
      return JSON.parse(s);
    } catch (e1) {
      // 第二轮：按「被截断」修补后再试（补引号 + 补括号）
      try {
        const fixed = repairJson(s);
        const obj = JSON.parse(fixed);
        console.warn(
          "[extractJson] 输出疑似被截断，已自动修补后解析。原始长度=" + raw.length
        );
        return obj;
      } catch (e2) {
        // 修补也失败：把原始返回打到控制台，方便定位是截断、格式错误还是空内容
        console.error("[extractJson] 解析失败，原始返回：\n" + raw);
        throw new Error(
          "日记 JSON 解析失败：" + e2.message +
          "\n常见原因：① 输出被截断；② 正文里出现了未转义的英文双引号。" +
          "\n可重试，或按 F12 看控制台里的原始返回。"
        );
      }
    }
  }

  // ---- 我的文风（粘贴自己的日记当样本）----
  function refreshMyStyleBtn() {
    const on = MyStyle.hasUsable();
    myStyleBtn.classList.toggle("active", on);
    myStyleBtn.textContent = on ? "我的文风 ●" : "我的文风";
    myStyleBtn.title = on
      ? "已启用：生成日记时会模仿你的语气"
      : "粘贴你自己的日记，让生成模仿你的语气";
  }

  // 统计粘了几段（按空行分隔），并提示实际会用前几段
  function updateMyStyleCount() {
    const n = String(myStyleInput.value || "")
      .split(/\n\s*\n+/)
      .map((s) => s.trim())
      .filter(Boolean).length;
    const used = Math.min(n, CONFIG.myStyleMaxSamples || 3);
    myStyleCount.textContent = n ? `共 ${n} 段，生成时用前 ${used} 段` : "还没粘贴内容";
  }

  function openMyStyle() {
    const st = MyStyle.get();
    myStyleInput.value = st.text;
    myStyleEnabled.checked = st.enabled;
    updateMyStyleCount();
    myStyleModal.hidden = false;
    myStyleInput.focus();
  }
  function closeMyStyle() {
    myStyleModal.hidden = true;
  }

  function setupMyStyle() {
    myStyleBtn.onclick = openMyStyle;
    myStyleInput.addEventListener("input", updateMyStyleCount);
    myStyleSave.onclick = () => {
      MyStyle.save({ text: myStyleInput.value, enabled: myStyleEnabled.checked });
      refreshMyStyleBtn();
      closeMyStyle();
      setStatus("我的文风已保存 ✦（下次生成日记生效）");
    };
    myStyleClear.onclick = () => {
      if (!confirm("清空已保存的「我的文风」样本？")) return;
      MyStyle.clear();
      myStyleInput.value = "";
      myStyleEnabled.checked = false;
      updateMyStyleCount();
      refreshMyStyleBtn();
      setStatus("已清空我的文风样本。");
    };
    myStyleClose.onclick = closeMyStyle;
    // 点遮罩空白处也能关
    myStyleModal.addEventListener("click", (e) => {
      if (e.target === myStyleModal) closeMyStyle();
    });
    refreshMyStyleBtn();
  }

  // ---- 开始一场新对话 ----
  function startConversation() {
    const conv = currentConv();
    messages = [
      { role: "system", content: buildConvSystem(conv) },
      { role: "assistant", content: conv.greeting },
    ];
    chatBox.innerHTML = "";
    addMessage("ai", conv.greeting);
  }

  // ---- 核心：发送一条用户消息 ----
  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;
    userInput.value = "";
    addMessage("user", text);
    messages.push({ role: "user", content: text });
    showThinking();
    sendBtn.disabled = true;
    try {
      const reply = await Api.chat(messages);
      messages.push({ role: "assistant", content: reply });
      removeThinking();
      addMessage("assistant", reply);
      setStatus("");
    } catch (e) {
      removeThinking();
      setStatus(e.message, true);
    } finally {
      sendBtn.disabled = false;
    }
  }

  // 选了「按我的文风」却用不了 —— 说清是哪种情况。
  // 只丢一句"没有样本"会让人懵：明明粘了，其实是"生成时模仿"开关没勾。
  function myStyleUnusableReason() {
    const s = MyStyle.get();
    if (!s.text || !s.text.trim()) return "还没粘贴你自己写的日记";
    if (!s.enabled) return "样本已粘好，但弹窗里「生成日记时模仿我的文风」没勾上";
    return "粘贴的内容里没有可用段落（多篇之间用空行分隔试试）";
  }

  // ---- 核心：生成日记 ----
  async function generateDiary() {
    // messages[0] 是 system，[1] 是开场白，真正对话从 [2] 起
    if (messages.length <= 2) {
      setStatus("先和伙伴聊几句，再生成日记吧～", true);
      return;
    }
    // 「按我的文风」必须真的有样本，否则宁可拦住也不生成 ——
    // 静默退回预设风格，用户会以为"纯模仿生效了"，实际拿到的还是预设腔。
    const pureMode = !!currentGen().pure;
    if (pureMode && !MyStyle.hasUsable()) {
      setStatus(
        "你选了「按我的文风」，但" + myStyleUnusableReason() +
        "。点右上角「我的文风」处理一下再生成。",
        true
      );
      return;
    }
    generateBtn.disabled = true;
    setStatus(
      pureMode
        ? "正在严格模仿你的文风写日记…"
        : MyStyle.hasUsable()
          ? "正在按你的文风写日记…"
          : "正在把今天写成日记…"
    );
    try {
      const profileText = Profile.toText(Profile.get());
      // 「我的文风」样本：用户粘的自己写的日记，最贴近本人语气，放在最后=优先级最高
      const useMyStyle = MyStyle.hasUsable();
      const myStyleText = MyStyle.toText();
      const genCtx = `\n\n【今天是 ${todayStr()}。】` +
        (recentDiariesBrief(2) ? "\n" + recentDiariesBrief(2) : "") +
        (profileText ? "\n" + profileText : "") +
        myStyleText;
      const genMessages = [
        // 有本人样本时关掉内置范例（withExamples:false），避免两种语气混味
        { role: "system", content: buildGen(currentGen(), { withExamples: !useMyStyle }) + genCtx },
        ...messages.filter((m) => m.role !== "system"),
        { role: "user", content: "请现在生成日记。" },
      ];
      // expectJson: 让 api.js 在输出没正常收尾时打诊断日志（便于定位截断）
      const raw = await Api.chat(genMessages, { temperature: 0.4, maxTokens: 2000, expectJson: true });
      const diary = extractJson(raw);
      const record = Store.save({
        title: diary.title,
        content: diary.content,
        mood: diary.mood,
        keywords: diary.keywords || [],
        conversation: messages.slice(2), // 存原始对话，方便回看
        convStyleId: currentConv().id, // 记录生成这篇日记时用的双维度风格
        genStyleId: currentGen().id,
      });
      // 传「完整记录」而不是模型返回的裸对象 —— 导出图片要用到 id / createdAt
      renderDiary(record);
      renderHistory();
      // 用户选了"每次生成日记自动更新画像"：生成完后用最近日记重算画像
      setStatus("日记已存，正在更新你的画像…");
      try {
        const p = await Profile.build();
        setStatus(p ? "日记生成完成，画像已更新 ✦" : "日记生成完成 ✦");
      } catch (e) {
        // 画像更新失败不影响日记本身，只提示
        setStatus("日记已生成（画像更新失败：" + e.message + "）", true);
      }
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      generateBtn.disabled = false;
    }
  }

  // 「已编辑」小标记（卡片 + 历史列表共用）。
  // 定位说清楚：它**只是界面提示**，不写进日记数据、也不会出现在导出的图片和复制出的文字里 ——
  // 日记内容就是内容，把 UI 说明混进数据会把数据弄脏。
  // 具体时间不占用视觉空间，放在 title 里，鼠标悬停能看到。
  function editedMark(d) {
    if (!d || !d.editedAt) return "";
    const t = new Date(d.editedAt);
    const p = (n) => String(n).padStart(2, "0");
    const when =
      t.getFullYear() + "/" + p(t.getMonth() + 1) + "/" + p(t.getDate()) +
      " " + p(t.getHours()) + ":" + p(t.getMinutes());
    return ` <span class="edited-mark" title="最后修改：${when}">已编辑</span>`;
  }

  function renderDiary(diary) {
    currentDiaryId = diary.id || null;
    currentDiary = diary;           // 导出要用完整记录
    diaryBox.innerHTML = "";
    const card = document.createElement("div");
    card.className = "diary-card";
    const mood = diary.mood ? `<span class="mood">${escapeHtml(diary.mood)}</span>` : "";
    const tags = (diary.keywords || [])
      .map((k) => `<span class="tag">#${escapeHtml(k)}</span>`)
      .join("");
    card.innerHTML = `
      <h2 class="diary-title">${escapeHtml(diary.title || "无题")}</h2>
      <div class="diary-meta">${mood} ${tags}${editedMark(diary)}</div>
      <p class="diary-content">${escapeHtml(diary.content || "")}</p>`;
    diaryBox.appendChild(card);
    diaryActions.hidden = false;    // 有日记了才露出导出按钮
  }

  // ---- 历史回看 ----
  function renderHistory() {
    const list = Store.getAll();
    historyList.innerHTML = "";
    if (!list.length) {
      historyList.innerHTML = '<p class="empty">还没有保存的日记。</p>';
      return;
    }
    list.forEach((d) => {
      const item = document.createElement("div");
      item.className = "history-item";
      const date = new Date(d.createdAt);
      const convName = (findConv(d.convStyleId) || {}).name || "—";
      const genName = (findGen(d.genStyleId) || {}).name || "—";
      item.innerHTML = `<div class="h-title">${escapeHtml(d.title || "无题")}</div>
        <div class="h-date">${date.toLocaleString()}${editedMark(d)}</div>
        <div class="h-style-row"><span class="h-style">${escapeHtml(convName)}</span><span class="h-style">${escapeHtml(genName)}</span></div>`;
      // 删除按钮：hover 出现，点击不触发"加载这篇"
      const delBtn = document.createElement("button");
      delBtn.className = "h-del";
      delBtn.textContent = "删除";
      delBtn.title = "删除这篇日记（不可恢复）";
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm("确定删除这篇日记吗？删除后无法恢复。")) {
          Store.remove(d.id);
          renderHistory();
          if (currentDiaryId === d.id) {
            diaryBox.innerHTML = "";
            currentDiaryId = null;
            currentDiary = null;
            diaryActions.hidden = true; // 日记没了，导出按钮要收起来
          }
          setStatus("已删除这篇日记。");
        }
      };
      item.appendChild(delBtn);
      item.onclick = () => {
        renderDiary(d);
        setStatus("已加载一篇历史日记。");
      };
      historyList.appendChild(item);
    });
  }

  // ---- 导出：存为图片 / 复制文字 ----
  // 排版与绘制都在 exporter.js，这里只负责「取当前日记 + 给用户反馈」。
  async function saveDiaryImage() {
    if (!currentDiary) {
      setStatus("还没有可以导出的日记，先生成一篇吧～", true);
      return;
    }
    saveImageBtn.disabled = true;
    setStatus("正在生成图片…");
    try {
      const name = await Exporter.exportImage(currentDiary);
      setStatus("图片已保存：" + name + "（没看到的话，看一眼浏览器的下载提示）");
    } catch (e) {
      // 不能静默失败：用户点了按钮必须知道结果
      setStatus("导出图片失败：" + e.message, true);
    } finally {
      saveImageBtn.disabled = false;
    }
  }

  async function copyDiaryText() {
    if (!currentDiary) {
      setStatus("还没有可以复制的日记，先生成一篇吧～", true);
      return;
    }
    try {
      await Exporter.copyText(Exporter.diaryToText(currentDiary));
      setStatus("日记文字已复制到剪贴板 ✦");
    } catch (e) {
      setStatus("复制失败：" + e.message, true);
    }
  }

  // ---- 编辑：手改 AI 生成的内容 ----
  // 为什么要有这个功能：AI 写得再顺，也总有"这词不对""这事它记岔了"的时候。
  // 只让重新生成的话，用户就只能迁就 AI 的措辞 —— 那这篇日记就不算他自己的了。

  // 把一行输入拆成标签数组。
  // 分隔符放开一点（中英文逗号 / 顿号 / 分号 / 空格 / 换行），用户不用记格式；
  // 顺手去掉手打的 # 和重复项 —— 展示时会统一补上 #，写重复了看起来像 bug。
  function parseKeywords(s) {
    return String(s == null ? "" : s)
      .split(/[，,、;；\s]+/)
      .map((k) => k.replace(/^#+/, "").trim())
      .filter(Boolean)
      .filter((k, i, arr) => arr.indexOf(k) === i);
  }

  // 弹窗底部的实时提示：让用户知道"存下去会是什么样"，而不是盲填
  function refreshEditCount() {
    const n = String(editContent.value || "").trim().length;
    const kw = parseKeywords(editKeywords.value);
    const mood = String(editMood.value || "").trim();
    editCount.textContent =
      "正文 " + n + " 字 · 标签 " + kw.length + " 个" +
      (mood ? "" : " · 没填情绪") +
      (n ? "" : "（正文不能为空）");
  }

  function openEdit() {
    // 和导出一样：没有日记时给提示，而不是让页面崩
    if (!currentDiary) {
      setStatus("还没有可以编辑的日记，先生成一篇吧～", true);
      return;
    }
    editTitle.value = currentDiary.title || "";
    editContent.value = currentDiary.content || "";
    editMood.value = currentDiary.mood || "";
    editKeywords.value = (currentDiary.keywords || []).join(", ");
    refreshEditCount();
    editModal.hidden = false;
    editTitle.focus();
  }

  function closeEdit() {
    editModal.hidden = true;
  }

  function saveEdit() {
    if (!currentDiary) return;
    const content = String(editContent.value || "").trim();
    // 正文为空不给存：日记没内容就没意义，导出的图也会变成一张空卡片
    if (!content) {
      setStatus("正文不能为空 —— 日记总得有点内容，改完再保存。", true);
      editContent.focus();
      return;
    }
    const updated = Store.update(currentDiary.id, {
      title: String(editTitle.value || "").trim(),
      content: content,
      mood: String(editMood.value || "").trim(),
      keywords: parseKeywords(editKeywords.value),
    });
    if (!updated) {
      // update 找不到 id 会返回 null（比如这篇刚被删掉），要如实告诉用户
      setStatus("保存失败：没找到这篇日记，可能已经被删除了。", true);
      closeEdit();
      return;
    }
    // 关键一行：currentDiary 必须跟着换成新记录。
    // 它和 currentDiaryId 是两回事 —— 只更新其中一个，渲染和导出就会各说各话，
    // 表现是「编辑看着成功了，但存出来的图还是改之前的」，这种 bug 很隐蔽。
    renderDiary(updated);
    renderHistory();
    closeEdit();
    setStatus("已保存你的修改 ✦");
  }

  function setupEdit() {
    editBtn.onclick = openEdit;
    editSave.onclick = saveEdit;
    editCancel.onclick = closeEdit;
    editContent.addEventListener("input", refreshEditCount);
    editMood.addEventListener("input", refreshEditCount);
    editKeywords.addEventListener("input", refreshEditCount);
    // 点遮罩空白处也能关（和「我的文风」保持一致的手感）
    editModal.addEventListener("click", (e) => {
      if (e.target === editModal) closeEdit();
    });
  }

  // ---- Key 设置 ----
  function refreshKeyStatus() {
    const k = Api.getKey();
    if (k) {
      keyStatus.textContent = "Key 已填 ✦（" + k.slice(0, 6) + "…）";
      keyStatus.className = "ok";
      apiKeyInput.value = "";
    } else {
      keyStatus.textContent = "尚未填写 Key";
      keyStatus.className = "warn";
    }
  }

  // ---- 事件绑定 ----
  sendBtn.onclick = sendMessage;
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  generateBtn.onclick = generateDiary;
  saveImageBtn.onclick = saveDiaryImage;
  copyTextBtn.onclick = copyDiaryText;
  newBtn.onclick = () => {
    startConversation();
    diaryBox.innerHTML = "";
    // 顺手修的既有 bug：原来只清空了界面，没清 currentDiary。
    // 后果是「开新对话后盒子空了，但按钮还在」，点「存为图片」导出的其实是上一篇、
    // 现在加了「编辑」更明显 —— 会打开一篇界面上根本看不到的旧日记。
    currentDiaryId = null;
    currentDiary = null;
    diaryActions.hidden = true;
    setStatus("");
  };
  saveKeyBtn.onclick = () => {
    const v = apiKeyInput.value.trim();
    if (!v) {
      setStatus("请输入 Key 再保存。", true);
      return;
    }
    Api.setKey(v);
    refreshKeyStatus();
    setStatus("Key 已保存到本地浏览器 ✦");
  };

  // ---- 风格下拉框：填充选项 + 回填上次选择 + 切换时生效 ----
  function setupStyleSelects() {
    // 填充「对话风格」
    CONV_STYLES.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      o.title = s.desc;
      convSelect.appendChild(o);
    });
    // 填充「生成风格」
    GEN_STYLES.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      o.title = s.desc;
      genSelect.appendChild(o);
    });
    // 回填上次选中的风格（没存过就用第一个）
    const savedConv = localStorage.getItem(CONFIG.convStyleKey);
    const savedGen = localStorage.getItem(CONFIG.genStyleKey);
    convSelect.value = savedConv && findConv(savedConv) ? savedConv : CONV_STYLES[0].id;
    genSelect.value = savedGen && findGen(savedGen) ? savedGen : GEN_STYLES[0].id;

    // 切换对话风格：记下选择；若对话还在开场（没聊过），立即换开场白；否则下一条回复起生效
    convSelect.addEventListener("change", () => {
      localStorage.setItem(CONFIG.convStyleKey, convSelect.value);
      if (messages[0]) messages[0].content = buildConvSystem(currentConv());
      if (messages.length <= 2) {
        const g = currentConv().greeting;
        messages[1] = { role: "assistant", content: g };
        chatBox.innerHTML = "";
        addMessage("ai", g);
      } else {
        setStatus("对话风格已切换（下一条回复起生效）");
      }
    });

    // 切换生成风格：只在生成日记时生效，记下选择即可
    genSelect.addEventListener("change", () => {
      localStorage.setItem(CONFIG.genStyleKey, genSelect.value);
      // 切到「按我的文风」但还没样本：当场提醒，别等点了生成才发现走不通
      if (currentGen().pure && !MyStyle.hasUsable()) {
        setStatus(
          "「按我的文风」暂时用不了：" + myStyleUnusableReason() + "（点右上角「我的文风」）",
          true
        );
      } else {
        setStatus("生成风格已切换（下次生成日记生效）");
      }
    });
  }

  // ---- 启动 ----
  setupStyleSelects();
  setupMyStyle();
  setupEdit();
  refreshKeyStatus();
  renderHistory();
  startConversation();
})();
