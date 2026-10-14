// mystyle.js —— 「我的文风」：用户粘贴自己写的日记，生成时当作 few-shot 模仿其语气
// 属于 Agent 工程里的 Context 层：给模型提供"这个人平时怎么写字"的真实样本。
// 数据只存在用户本地浏览器（localStorage），不上传。
const MyStyle = {
  // 读取已保存的样本（返回 { text, enabled }）
  get() {
    try {
      const raw = localStorage.getItem(CONFIG.myStyleStorageKey);
      if (!raw) return { text: "", enabled: false };
      const obj = JSON.parse(raw);
      return { text: obj.text || "", enabled: !!obj.enabled };
    } catch (e) {
      console.error("读取「我的文风」失败：", e);
      return { text: "", enabled: false };
    }
  },

  // 保存（text / enabled 任一项不传则保留原值）
  save(data) {
    const cur = this.get();
    const next = {
      text: data.text != null ? String(data.text) : cur.text,
      enabled: data.enabled != null ? !!data.enabled : cur.enabled,
    };
    localStorage.setItem(CONFIG.myStyleStorageKey, JSON.stringify(next));
    return next;
  },

  // 清空
  clear() {
    localStorage.removeItem(CONFIG.myStyleStorageKey);
  },

  // 把粘贴的文本切成样本：空行分隔 → 去空段 → 限量 → 截断（都是为控 token）
  samples() {
    const text = (this.get().text || "");
    const maxN = CONFIG.myStyleMaxSamples || 3;
    const maxChars = CONFIG.myStyleMaxChars || 400;
    return text
      .split(/\n\s*\n+/)               // 以「一个或连续空行」分段
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, maxN)
      .map((s) => (s.length > maxChars ? s.slice(0, maxChars) + "…" : s));
  },

  // 有可用样本吗（既要有内容，又要开着开关）
  hasUsable() {
    return !!(this.get().enabled && this.samples().length);
  },

  // 拼成注入生成指令的文本块；没内容或没启用时返回空串（拼接时无副作用）
  toText() {
    if (!this.hasUsable()) return "";
    const body = this.samples()
      .map((s, i) => `--- 样本${i + 1} ---\n${s}`)
      .join("\n\n");
    return (
      "\n\n【用户本人的写作样本——语气优先参考这一条】\n" +
      "下面几段是用户自己写的，请重点模仿他的语气、节奏、用词和标点习惯，" +
      "优先级高于前面给出的通用范例：\n" +
      body +
      "\n注意：只模仿「怎么写」，不要照搬样本里的人和事；" +
      "日记内容仍必须来自本次对话，不得编造。"
    );
  },
};
