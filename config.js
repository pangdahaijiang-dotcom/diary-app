// config.js —— 项目配置集中处
// 把所有「以后可能要改的东西」都放这里，换模型/换接口只动这一处。
// 这是给胖大海看的：你将来想换模型，改下面的 model 名字即可，不用翻其他文件。
const CONFIG = {
  // DeepSeek 的 API 地址（和 OpenAI 格式兼容，调用方式一样）
  // 默认走本地代理（见 proxy.py），绕过浏览器 CORS 拦截。
  // 如果你想冒险直连，可改成 "https://api.deepseek.com"，但浏览器大概率会报 CORS。
  apiBase: "http://localhost:8080",

  // 第一阶段（纯文字：对话挖掘 + 生成日记）用的模型：正式版、稳、便宜
  textModel: "deepseek-v4-flash",
  // 第二阶段要「识图」时，把上面的 textModel 换成这个（实验性多模态模型，支持图文）
  visionModel: "deepseek-v4-flash-vision-exp",

  // 用户在界面里填的 API Key 存到浏览器 localStorage 时用的键名
  keyStorageKey: "diary_app_api_key",
  // 日记数据存到 localStorage 时用的键名
  diaryStorageKey: "diary_app_diaries",
  // 用户选中的「对话挖掘风格 / 日记生成风格」id 存到 localStorage 时用的键名
  convStyleKey: "diary_app_conv_style",
  genStyleKey: "diary_app_gen_style",
  // 自动归纳的「用户画像」存到 localStorage 时用的键名（跨天记忆的升级版）
  profileStorageKey: "diary_app_profile",
  // 归纳画像时最多参考最近几篇日记（控成本，也够稳定）
  profileSampleSize: 10,

  // 用户粘贴的「我的文风」样本（自己写的日记）存到 localStorage 的键名
  myStyleStorageKey: "diary_app_my_style",
  // 注入生成指令时：最多取几条样本、每条约截断多少字（控 token、防超长）
  myStyleMaxSamples: 3,
  myStyleMaxChars: 400,
};
