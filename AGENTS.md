# AGENTS.md — 日记挖掘伙伴（diary-app）

> 本文件是项目的**长期规则与协作约定**，属于 Agent 工程里的 **Harness（执行约束系统）** 层。
> 任何 AI 或协作者改代码前必须先读它。它不是「建议」，是约束。
> 当前任务的具体进度放在 Plan / 对话里，不写进这里（避免旧任务污染新任务）。

## 项目一句话

一个会和你聊天、把今天「挖」成一篇日记的**本地网页**（物光创新实验室 2026 招新作品）。核心是「引导式对话解决日记开头难」+「AI 整理成结构化的日记 + 一键导出成可分享的图片」。

## 技术栈（固定，勿擅改）

| 项 | 取值 | 说明 |
|---|---|---|
| 前端 | 纯 HTML + CSS + 原生 JS（无框架、无构建） | 降低运行门槛，双击 start.bat 即开 |
| 模型 | DeepSeek API（文本 `deepseek-v4-flash`） | 模型名集中在 config.js |
| 存储 | 浏览器 localStorage（`diary_app_diaries` / `diary_app_profile` / `diary_app_my_style` 等，键名集中在 config.js） | 数据只在本地，不上传 |
| 代理 | 本地 `proxy.py`（Python，端口 8080） | 绕过浏览器 CORS |
| 样式方案 | 零构建 CSS：本地 vendored 的 `open-props.min.css` 提供 design token，`style.css` 做语义映射 | 不引入 Tailwind / 构建链，保证双击离线可跑 |

> 技术栈是 Harness 的一部分：引入新框架 / 新依赖前**必须先和用户确认**，不在单一任务里私自扩大范围。
> **未实现**：`config.js` 里保留了多模态识图模型名（`deepseek-v4-flash-vision-exp`）作为以后扩展的入口，但**代码里没有任何识图功能**，别把它当成已有能力。

## 文件结构（每个文件只干一件事）

| 文件 | 职责 |
|------|------|
| `config.js` | 配置集中处（API 地址、模型名、存储键名、样本条数/字数上限）。换模型/换接口只动这里。 |
| `store.js` | 日记本地存储（增 / 删 / **改** / 查）。`update(id, patch)` 只覆盖传入字段，并强制保留原 `id` / `createdAt`（改的是内容，不是「什么时候写的」）、写下 `editedAt`；找不到 id 返回 **null** 而不是假装成功。`save` 负责保证 **id 唯一**（同一毫秒连存两篇会撞，撞了会改错篇）。 |
| `api.js` | 封装对 DeepSeek 的调用（Key 读取、温度/长度参数、错误处理、截断诊断）。 |
| `styles.js` | 风格预设集。生成指令有**两种拼装**：① 预设风格 = 底座三件套 `GEN_BASE_RULES` / `GEN_EXAMPLES` / `GEN_FORMAT` + 该风格 `genTwist`（传 `{ withExamples:false }` 可关掉内置范例）；② **纯模仿**（`GEN_STYLES` 里 `{ pure:true }` 的「按我的文风」）= 只拼 `GEN_MINE_RULES` + `GEN_FORMAT`，撤掉通用语气要求、范例和一切 `genTwist`，并在指令里点名压制「前面对话的语气」和「近期日记回顾的语气」两个隐藏污染源。想加/改语气只动这里。**`GEN_FORMAT` 同时承担「给机器读的格式约束」**：禁止字符串内英文双引号、要求正文换行写成 `\n`（后者是导出图片能分段排版的前提）。 |
| `profile.js` | 用户画像（Context 层）：从最近日记归纳稳定事实，注入对话与生成。 |
| `mystyle.js` | 「我的文风」（Context 层）：用户粘贴自己写的日记当 few-shot，生成时模仿其语气。 |
| `exporter.js` | 导出：手账风图片的排版与绘制 + 纯文字复制。**关键设计：排版计算（`buildImagePlan` / `layoutBody` / `wrapParagraph` 都是纯函数、可无头测）与 canvas 绘制分开**。排版层已处理两件中文排版的事：① 段落间距（`layoutBody`，换行即段边界，段间加 `PARAGRAPH_GAP`，段内只有行高）；② 中文禁则（避头尾：标点不落行首 → 悬挂到上一行尾，`MAX_HANG=2`；开括号不落行尾 → 回拉到下一行）。 |
| `app.js` | 主逻辑：对话状态、生成日记、历史回看、Key 设置、风格下拉、「我的文风」弹窗、**编辑弹窗**（`openEdit` / `saveEdit` / `parseKeywords`），外加 `extractJson` / `repairJson`（容错解析）。Prompt 已迁出到 `styles.js`，这里只负责「读配置 + 拼装 + 渲染」。 |
| `index.html` / `style.css` | 页面结构与样式。所有可视变量集中在 `style.css` 的 `:root`，换肤只动一处。 |
| `open-props.min.css` | 本地 vendored 的 Open Props 设计变量（离线可用，勿改成 CDN）。 |
| `proxy.py` | 本地代理（CORS 兜底；**必须读完整上游响应后再发头 + 显式 Content-Length**，否则会切包）。 |
| `tests/` | 无头回归测试（Node vm + DOM 桩，不用开浏览器、不用 API Key）。`node tests/run-all.js` 一次跑完。 |
| `start.bat` | Windows 一键启动（代理 + 服务器 + 开浏览器）。 |
| `.gitignore` | 排除用户数据；源码全部提交。 |

## Agent 规则（AI 可以和不可以）

**可以做**
- 改 `styles.js` 里的风格预设（`CONV_STYLES` / `GEN_STYLES` / `GEN_BASE_RULES` / `GEN_EXAMPLES` / `GEN_EXAMPLES_OMITTED` / `GEN_FORMAT` / `GEN_MINE_RULES`）来调对话/日记质量。
- 改 `config.js` 里的模型名 / 地址 / 存储键名（保持集中管理）。
- 给 `proxy.py` / `start.bat` 做健壮性修复（如端口复用、编码、响应完整性）。
- 补小功能（删日记按钮、编辑、导出）并同步更新 README。
- 往 `tests/` 加回归用例（改成「可验证的失败模式」是受欢迎的做法）。

**不可以（边界）**
- ❌ 把 API Key 写死进代码或提交仓库。Key 必须由用户在界面填、存浏览器 localStorage。
- ❌ 擅自引入框架（React / Vue 等）或新依赖。
- ❌ 删除或覆盖用户已生成的日记数据文件。
- ❌ 在没真机验证前就说「完成」。

## 验证方式（Evaluate / Verify — 结论要有证据）

不靠「AI 说跑通了」就当完成。本项目的验收手段：
1. 双击 `start.bat` → 填 Key → 真实对话 4~5 轮 → 点「生成日记 ✦」。
2. 肉眼读产物：日记是否口语、无 AI 套路、情绪/关键词是否合理。
3. 改完 Prompt 必须**重新生成一篇**对比，旧产物不能算数。
4. 浏览器 F12 → Application → Local Storage 确认日记确实写入。
5. 逻辑类改动先跑 `node tests/run-all.js`，拿到「全部通过」再上真机。现有 5 个测试文件：
   - `json-repair.test.js` —— 模型输出被截断时的解析容错 + 正文换行转义的还原
   - `gen-prompt.test.js` —— 生成指令拼装 + 纯模仿模式的拦截逻辑
   - `exporter.test.js` —— 导出排版计算（换行 / 溢出 / 高度 / 边界 / 段落间距 / 中文禁则）
   - `export-flow.test.js` —— 导出全链路（接线 → 绘制 → 下载 / 复制，用 canvas 桩）
   - `edit-diary.test.js` —— 编辑日记（Store.update 语义 / 标签解析 / 编辑后各处同步；**用 canvas 桩断言导出的确实是改后的内容**）
6. **导出图片的视觉验证可以不用等真机**：本机装了 Chrome，可以用无头模式渲染一个临时预览页并截图，
   再把图读回来看（`chrome --headless=new --dump-dom` 取尺寸 → `--screenshot` 出图）。
   这条路已经抓出两个纯逻辑断言抓不到的问题：情绪 chip 独占一行、正文段落糊成一片。

> **测试覆盖的边界要如实说**：canvas 桩能验证「不抛错、尺寸对、画了字、触发了下载」，
> **验证不了「好不好看」**。第 6 条的截图是「本机 Chrome 里长什么样」的证据，比空口断言强得多，
> 但它**不等于真机**：字体、DPR、下载流程仍要真机确认。别用"测试全绿"或"截图看着行"代替真机那一步。

> 真机反馈比 AI 自检更可信。CORS、Python 环境、缓存等问题只能在真机暴露。

### 已知失败模式（踩过的坑，别再踩）

| 症状 | 根因 | 对策 |
|---|---|---|
| `JSON 解析失败：Unterminated string ... at position N` | 模型输出被截断（撞 max_tokens，或代理切包） | `repairJson` 补字符串+括号栈；`proxy.py` 显式 Content-Length；`maxTokens` 留足 |
| 同上，但正文里出现英文双引号 | 未转义的 `"` 破坏 JSON 结构，补括号**救不了** | 已在 `GEN_FORMAT` 里硬性禁止字符串内出现英文双引号（改用「」或 \( \)） |
| 改了 JS 但页面行为没变 | `index.html` 里 `?v=` 版本号没跟着改，浏览器吃缓存 | 改动过的脚本同步 bump 版本号 |
| 同一天改了两次，第二次仍不生效 | `?v=` 只精确到日期，同一天内两次改动指向同一个 URL | 同一天再改就加后缀（如 `?v=20261013b`），保证 URL 唯一 |
| 导出图里多段正文糊成一整块，看不出分段 | 两个原因叠加：`exporter.js` 按「第 i 行 × 行高」定位（段间距离＝行内距离），且 `GEN_FORMAT` 从没要求正文分段 | `layoutBody` 让换行即段边界、段间加 `PARAGRAPH_GAP`；`GEN_FORMAT` 补「换行写成 `\n`」的格式要求。**注意**：只认空行分段是不够的 —— 人写日记段间就是一个换行 |
| 导出图里「，回头一看」这类标点跑到行首 | canvas 逐字换行没有中文禁则（避头尾） | `wrapParagraph` 做悬挂标点（标点挂在上一行尾，上限 `MAX_HANG=2`）+ 开括号回拉。**代价**：该行最多超出版心 2 个字宽（36px）< 卡片内边距 42px，所以不会顶到卡片边 |
| Prompt 里要求模型输出 `\n`，但模型收到的提示词里变成真换行 | 模板字符串里写 `\n` 会被 JS 解释成换行符，必须写 `\\n` 才是字面量 | 改完 Prompt 用 `node -e` 打印 `JSON.stringify(GEN_FORMAT)` 验一眼实际字面量 |
| 编辑保存后，卡片/历史/导出里还是旧内容 | 只更新了 `currentDiaryId`，忘了同步 `currentDiary`（导出读它） | 保存后必须 `renderDiary(updated)`，**用 `updated` 而不是重新拼** —— 测试里就用 canvas 桩断言"导出画的是新正文" |
| 同一毫秒内连存两篇日记，之后改一篇却发现改的是另一篇 | `id` 用 `"d_" + Date.now()` 生成，同毫秒撞车；`update` / `remove` 都按 id 定位 | `save` 里撞了就追加序号（`d_xxx_2`）。写测试时连着 `Store.save` 两次就能稳定复现 |
| 新建对话后日记盒子空了，但「存为图片 / 编辑」按钮还在 | 旧代码只清 `diaryBox`，没清 `currentDiary` 与 `diaryActions.hidden` | 三个一起清（2026-10-14 修） |
| 「已编辑」标记混进了导出的图片或复制出的文字 | 把界面标记写进了日记数据（或渲染时顺手塞进 title/content） | 标记只在渲染层拼（`editedMark(d)`），**不进数据、不进导出**；已用断言锁住「导出文字/画布内容里不含『已编辑』」 |

## 迭代纪律（Loop — 执行要窄、思考要宽）

- 复杂改动先想清楚再动（Explore），不拿到需求就直接写。
- 一次只改一个明确目标；发现额外问题先**提建议**，不擅自顺手全做了。
- 改坏能恢复：源码在 Git / 桌面目录，改前确认可回退。
- 同一文件的多次编辑要**串行**（并行 Edit 会互相覆盖，却都回「成功」）。
- 经验沉淀：验证过的做法进 README / memory；未确认的只当假设。

> 一句话：**目标清楚、思考开放、执行受控、结果可验、经验可沉淀。**
