# 课堂实时助手（Turtle Project）

一个面向 Windows 本机、单用户、桌面端课堂场景的 localhost 应用。它使用 Edge/Chrome 的浏览器语音识别把中文麦克风语音变成可编辑转写，在本机 SQLite 中保存课程资料，并可通过 DeepSeek 增量整理双版本笔记、自动发现课堂问题和回答问题。

## 功能

- 课程与课堂会话的创建、重命名、删除、历史打开和异常恢复。
- 麦克风中文连续识别，区分临时结果与最终结果，暂停、继续、有限退避恢复和重复片段过滤。
- 最终转写立即保存；转写可编辑、标记重点、复制和全文检索。
- 完整版讲义和提纲版复习笔记独立增量更新；稳定内容块、编辑锁、修订快照和撤销。
- 本地规则发现完整课堂问题，去重并自动调用 DeepSeek；答案默认只进入课堂问答。
- 手动问答支持 Enter 发送、Shift+Enter 换行、真实流式显示、停止、编辑、复制、重新生成和归档。
- 问答可加入完整版、提纲版或两个版本，能够移除且不删除原问答。
- SQLite FTS5 对转写、笔记、问答和导入资料做中文子串全文检索。
- 导入 TXT、Markdown、DOCX；导出 DOCX、Markdown、TXT 或完整课堂包。
- 无 API Key 时，除 AI 功能外的课程、转写、编辑、检索、导入和导出均可使用。

## 技术架构

```text
Turtle-project/
├─ apps/
│  ├─ web/          React 19 + Vite + TypeScript
│  └─ server/       Node.js + Express + TypeScript
├─ packages/
│  └─ shared/       Zod 输入契约、共享类型和领域规则
├─ tests/           Vitest 集成与单元测试
├─ package.json     npm workspaces 与统一命令
└─ README.md
```

后端只监听 `127.0.0.1`。前端通过 Vite Proxy 访问后端，不直接访问数据库，也不直接携带 DeepSeek Key 请求公网。SQLite 使用 Node 当前 LTS 自带的 `node:sqlite`，不需要 Visual Studio C++、Python、Docker 或 WSL；FTS5 使用 trigram 分词支持中文子串检索。

## Windows 环境与启动

建议 Windows 10/11、Node.js 24 LTS、npm 11 或更新版本。最低支持版本写在 `package.json`（Node.js 22+），但推荐使用 Node 24 LTS，以获得当前稳定的内置 SQLite 行为。

```powershell
git clone https://github.com/Clara-Cui2006/Turtle-project.git
cd Turtle-project
npm install
npm run dev
```

开发命令会同时启动前后端并打开浏览器：

- 网页：<http://localhost:5173>
- 后端：<http://localhost:3001>
- 健康检查：<http://localhost:3001/api/health>

其他命令：

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

如果端口被占用，请先关闭占用 5173 或 3001 的本机进程。后端端口可用 `PORT` 环境变量临时调整，但同时需要更新 Vite Proxy。

## 第一次使用与 DeepSeek

1. 打开右上角“设置”。
2. 在 API Key 输入框填写 Key。Key 不会写入浏览器 localStorage 或 IndexedDB。
3. 保持 Base URL 为 `https://api.deepseek.com`，或填写兼容的 HTTPS 地址。
4. 点击“测试连接”。测试只发送一个极短请求。
5. 成功后点击“保存设置”。

当前官方推荐的默认普通模型是 `deepseek-flash`，深度模型是 `deepseek-v4-pro`；四个任务模型均可在设置中修改。模型名称变化或账号无权使用时，测试连接会显示明确错误。参考 [DeepSeek 官方快速开始](https://api-docs.deepseek.com/) 与 [官方模型价格页](https://api-docs.deepseek.com/quick_start/pricing)。

设置文件位于：

```text
%APPDATA%\TurtleProject\local-settings.json
```

Key 仅由 localhost 后端读取；GET 设置接口只返回是否配置和脱敏值。文件以当前用户创建并尝试设置为仅当前用户读写；Windows 上最终访问范围仍取决于该用户目录的 NTFS ACL。本项目没有实现操作系统凭据保险箱加密，因此不会声称 Key 已加密。不要共享该文件。

点击“清除 API Key”会立即阻止新的 AI 请求。本地课堂功能仍可继续使用。

## 上课流程

1. 左侧点击“新建课程”，填写名称和教师。
2. 选中课程并点击“新建课堂”。
3. 点击顶部“开始转写”，浏览器会申请麦克风权限。
4. 允许后，临时文字用虚线框显示，不写入数据库；最终文字会立即保存。
5. 可暂停、继续或结束课堂。已结束课堂必须明确确认“继续本节课堂”才会追加转写。
6. 页面刷新或程序重启后，应用会恢复最近课堂；未正常结束的课堂仍显示为进行中。

麦克风权限被拒绝时，点击浏览器地址栏左侧的网站权限图标，把“麦克风”改为“允许”，然后重新点击开始。第一版只捕获麦克风，不捕获系统内部声音、不区分说话人，也不保存原始音频。

## 双版本笔记

- 完整版：使用完整句子和层级章节，接近可复习讲义，保留课堂逻辑、时间依据、老师讲述、AI 补充和待核实内容。
- 提纲版：明显更短，使用项目符号，突出层级知识点、法条、案例、易错点和复习问题。

最终转写累计达到设置字数时，系统经过短防抖后更新；否则到达设置时间后更新。两个版本使用独立串行队列和锁，不阻塞转写或彼此覆盖。失败时不推进 `lastProcessedAt`，因此待处理转写不会丢失；用户也可点“立即整理”。

笔记不是单个会被整体替换的 Markdown 字符串。每个内容块都有稳定 ID、来源和顺序。用户编辑后，块会自动标记为已编辑并锁定；后续 AI 只能追加未锁定的自动内容，与锁定内容相关的信息作为新建议块加入。每篇笔记保留最近 20 次修订，可撤销最近更新。无 Key 时可用“新增笔记块”手写笔记。

## 自动发现问题与手动提问

自动发现只读取最终转写。系统先用本地规则过滤口头禅和过短疑问，以规范化问题文本去重，并设置 30 秒冷却；语义完整但没有问号的问题可能标记为“可能是课堂设问”。识别后，自动问答使用独立队列调用 DeepSeek，不会阻塞转写和笔记。

答案按当前课堂、历史课堂、导入资料、AI 一般知识和待核实内容区分，记录实际使用的来源。系统只取相关片段并限制上下文长度，不会每次发送全部数据库。自动答案默认不写入笔记；可点击“加入完整版”“加入提纲版”“同时加入”或“从笔记移除”。加入两版时分别采用讲义表达和精简提纲表达，不机械复制。

“手动提问”支持常用快捷问题、流式输出和停止生成。Enter 发送，Shift+Enter 换行。课堂记录里没有答案时，提示词要求模型明确说明。

## 导入、检索与导出

点击“导入”或把文件拖入对话框：

- `.txt` 与 `.md`：UTF-8 文本和标题分块。
- `.docx`：解析普通段落、标题和列表，不执行宏、脚本或嵌入对象。
- `.doc`：不支持，会提示用 Word 另存为 `.docx`。
- 单文件限制 10MB；用 SHA-256 防止同一课程无提示重复导入。

设置中“保留导入原文件”默认关闭，此时只存解析文字和元数据。开启后原文件存入本机数据目录的 `imports` 子目录；删除资料时会一起删除原文件、解析块和全文索引。

顶部“导出”可选择 Word、Markdown、纯文本，以及完整版、提纲版、两版笔记、完整转写、课堂问答或完整课堂包。DOCX 使用清晰标题层级、中文文件名、时间戳和问答加入状态，不会包含 API Key、内部路径或调试信息。导出失败不会修改数据库。

## 本地数据、隐私与删除

默认数据目录：

```text
%APPDATA%\TurtleProject
├─ turtle.db
├─ turtle.db-wal / turtle.db-shm（运行时可能存在）
├─ local-settings.json
└─ imports\（仅开启保留原文件时）
```

可用非敏感环境变量 `TURTLE_DATA_DIR` 覆盖目录，便于测试。数据库和历史课堂主要保存在本机，但本项目不是完全离线软件：

1. AI 请求会把必要的课堂文字、问题和相关笔记发送给 DeepSeek。
2. 原始音频默认不保存，也不发送给 DeepSeek。
3. Edge/Chrome 语音识别可能使用浏览器厂商的在线服务。
4. 本地文件安全取决于 Windows 用户账户、磁盘和目录权限。

彻底删除数据：先结束 `npm run dev`，再删除 `%APPDATA%\TurtleProject`。这会永久删除 Key、所有课程、课堂、转写、笔记、问答和保留的导入文件，请自行先导出备份。

`.gitignore` 已排除 `.env*`、`node_modules`、`dist`、`coverage`、`data`、`uploads`、`recordings`、`exports`、临时目录、数据库、设置、日志和缓存。不要把本地数据目录、真实 Key、课堂转写、笔记、导入资料、导出文件或录音提交到 GitHub。

## 浏览器兼容性与限制

推荐最新版 Microsoft Edge 或 Google Chrome。应用检测 `SpeechRecognition` / `webkitSpeechRecognition`，默认 `zh-CN`、连续识别和临时结果。Firefox 通常不提供该接口；不支持时，本地课程、手写笔记、导入、检索和导出仍可使用。

当前限制：Windows localhost、单用户、桌面端优先；不提供公网部署、账号登录、云同步、手机远程访问、系统内部声音捕获、精确说话人区分、完全离线识别、PDF 或图片 OCR。浏览器识别质量和在线可用性由浏览器厂商控制。

未来替换本地 Whisper 时，实现与 `BrowserTranscriptionProvider` 相同的开始、暂停、停止、临时/最终结果和状态回调即可；数据库与上层 UI 不需要改写。Whisper、Python 和额外语音服务未被当前版本安装。PDF 与图片 OCR 计划在后续版本增加，不影响现有 TXT/Markdown/DOCX 流程。

## 常见问题

| 问题 | 处理方法 |
|---|---|
| 麦克风权限被拒绝 | 在地址栏网站权限中允许 localhost 使用麦克风，再重新开始。 |
| 浏览器不支持语音识别 | 使用最新版 Edge/Chrome；仍可手动记录、导入和导出。 |
| DeepSeek Key 无效 | 在设置重新填写，点击测试连接；完整 Key 不会从读取接口返回。 |
| 模型不可用 | 把任务模型改为账号当前可用的官方模型名并重新测试。 |
| 额度不足 | 到 DeepSeek 平台检查余额或配额，本地保存不受影响。 |
| 请求过于频繁 | 稍后重试；后端会有限重试且不同任务使用独立队列。 |
| 网络异常 | 检查代理、防火墙与 `https://api.deepseek.com`；待处理转写不会丢失。 |
| Word 导入失败 | 确认是有效 `.docx` 且小于 10MB；旧 `.doc` 请另存为 `.docx`。 |
| 数据库无法打开 | 检查 `%APPDATA%\TurtleProject` 权限、磁盘空间和是否被其他程序锁定；不要删除 WAL 文件来“修复”。 |
| 端口被占用 | 关闭占用 5173/3001 的程序后重启。 |

## 测试说明

自动化测试不会访问真实 DeepSeek，也不会消耗 API 额度。Mock 集成流程覆盖新建课程和课堂、最终转写、双版本笔记、发现并回答问题、答案加入两版笔记、重新读取、FTS5、设置脱敏、语音恢复、TXT/Markdown/DOCX 导入以及 DOCX/Markdown/TXT 导出。
