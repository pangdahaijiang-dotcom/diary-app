// api.js —— 封装对 DeepSeek 的调用
// 这是整个项目「和 AI 说话」的唯一入口。其他文件不要直接 fetch，统一走这里。
const Api = {
  // 从 localStorage 取用户自己填的 key
  getKey() {
    return localStorage.getItem(CONFIG.keyStorageKey) || "";
  },

  // 设置 key（用户在设置框里填的）
  setKey(key) {
    localStorage.setItem(CONFIG.keyStorageKey, key.trim());
  },

  // 核心方法：把一段「对话消息」发给模型，返回模型回复的文本
  // messages 格式：[{ role: "system"|"user"|"assistant", content: "..." }]
  // opts 可选：{ model, temperature, maxTokens }
  //   - 聊天挖掘用默认温度 0.8（有变化）；生成日记单独用低温度更稳、不胡编
  async chat(messages, opts) {
    opts = opts || {};
    const key = this.getKey();
    if (!key) {
      throw new Error("还没有填写 API Key，请先在右上角设置里填好。");
    }

    let res;
    try {
      res = await fetch(CONFIG.apiBase + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify({
          model: opts.model || CONFIG.textModel,
          messages: messages,
          temperature: opts.temperature != null ? opts.temperature : 0.8,
          max_tokens: opts.maxTokens || 1200,
          // stream 默认 false：一次性返回完整结果，简单可靠（后续可改流式）
        }),
      });
    } catch (networkErr) {
      // 走到这里通常是网络不通，或被浏览器的 CORS 跨域策略拦截
      throw new Error(
        "网络请求失败：可能是没联网，或被浏览器跨域(CORS)拦截。\n" +
          "若提示 CORS，请改用本地代理方式运行（见 README）。"
      );
    }

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch (e) {
        body = "(无法读取错误响应体)";
      }
      console.error("[Api.chat] 非 2xx 响应：HTTP " + res.status + "\n" + body);
      if (res.status === 401) {
        throw new Error("API Key 无效（HTTP 401）。请检查 DeepSeek 后台的 key 是否正确。");
      }
      throw new Error("调用失败：HTTP " + res.status + "\n" + body.slice(0, 200));
    }

    let data;
    try {
      data = await res.json();
    } catch (jsonErr) {
      let raw = "";
      try {
        // 重新 clone/读取响应体原文，方便诊断
        raw = await res.clone().text();
      } catch (e) {
        raw = "(无法读取响应体)";
      }
      console.error("[Api.chat] 响应不是合法 JSON：\n" + raw);
      throw new Error("模型返回的不是合法 JSON，可能是响应为空或被截断。\n" + raw.slice(0, 200));
    }
    const choice = data && data.choices && data.choices[0];
    if (!choice || !choice.message) {
      console.error("[Api.chat] 返回结构异常：", JSON.stringify(data).slice(0, 300));
      throw new Error("模型返回结构异常：缺少 choices / message 字段。");
    }
    const content = choice.message.content;
    const finishReason = choice.finish_reason;

    // 截断诊断：
    //   finish_reason = "length" → 撞到输出上限被截断
    //   expectJson 且内容结尾不是 } → 大概率在传输/生成中途断了
    const looksCut =
      opts.expectJson && content && !String(content).trim().endsWith("}");
    if (finishReason === "length" || looksCut) {
      console.warn(
        "[Api.chat] 疑似输出被截断：finish_reason=" + finishReason +
          "，返回长度=" + (content ? String(content).length : 0) +
          "，max_tokens=" + (opts.maxTokens || 1200)
      );
    }
    return content;
  },
};
