// profile.js —— 用户画像：从过往日记归纳"稳定事实"，持久化到本地，供对话/生成注入
// 这是「跨天记忆」的升级版：
//   · recentDiariesBrief（已做）= 近期"发生了什么" → 管连贯
//   · Profile（本文件）        = "你是谁"的稳定事实 → 管个性化、精准交互
// 全部在本地 localStorage，不上传任何服务器。
const Profile = {
  // 读已存的画像（没有或损坏就返回 null）
  get() {
    try {
      const raw = localStorage.getItem(CONFIG.profileStorageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  // 存画像
  save(p) {
    localStorage.setItem(CONFIG.profileStorageKey, JSON.stringify(p));
  },

  // 把画像对象拼成"注入用文本"；没有画像就返回空串（调用方据此决定是否拼接）
  toText(p) {
    if (!p) return "";
    const lines = [];
    if (p.identity) lines.push("· 身份/阶段：" + p.identity);
    if (p.people && p.people.length) lines.push("· 常出现的人：" + p.people.join("、"));
    if (p.ongoing && p.ongoing.length) lines.push("· 持续推进的事：" + p.ongoing.join("、"));
    if (p.prefs && p.prefs.length) lines.push("· 偏好/习惯：" + p.prefs.join("、"));
    if (p.mood) lines.push("· 情绪基调：" + p.mood);
    if (p.summary) lines.push("· 画像小结：" + p.summary);
    if (!lines.length) return "";
    return "【用户画像（由过往日记归纳，仅供自然衔接，绝不替用户编造）】\n" + lines.join("\n");
  },

  // 调模型，从最近若干篇日记重算画像（用户选了"每次生成日记自动更新"）
  // 返回画像对象；无日记时返回 null。
  async build() {
    const list = Store.getAll().slice(0, CONFIG.profileSampleSize).reverse(); // 时间正序
    if (!list.length) return null;
    const corpus = list
      .map((d) => {
        const dt = new Date(d.createdAt);
        const c = (d.content || "").replace(/\s+/g, " ").slice(0, 300);
        return `${dt.getMonth() + 1}月${dt.getDate()}日《${d.title || "无题"}》：${c}`;
      })
      .join("\n");

    const sys = `你是"用户画像抽取器"。根据下面若干篇日记，抽取稳定、可复用的用户事实，让日记助手更懂这个人。
规则：
1. 只从日记【明确提及】的事实提取，严禁推测、严禁编造。
2. 信息不足的项就留空数组或省掉，不要硬凑。
3. 输出严格 JSON（不要代码块、不要任何解释文字）：
{"identity":"一句话身份/阶段","people":["常出现的人/关系"],"ongoing":["持续推进的事"],"prefs":["偏好/习惯"],"mood":"情绪基调(可空字符串)","summary":"2-3句整体画像,口语自然"}`;

    const raw = await Api.chat(
      [
        { role: "system", content: sys },
        { role: "user", content: corpus },
      ],
      { temperature: 0.3, maxTokens: 600 }
    );
    const p = parseJsonSafe(raw);
    if (p) this.save(p);
    return p;
  },
};

// 容错解析：防模型顺手包 ```json 或加解释；解析失败返回 null（不污染本地画像）
function parseJsonSafe(s) {
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b >= 0) t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}
