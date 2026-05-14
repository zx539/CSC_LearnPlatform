
# 基于星火大模型的个性化资源生成与学习多智能体系统（Web版）

本项目已重构为 **前后端分离目录**，并提供 **标签页风格、明亮活泼 UI** 的前端页面，后端通过 `requests` **真实调用星火 AI 接口**。

---

## 1. 重构后的目录结构

```text
.
├── backend/
│   ├── app.py                         # Flask Web 服务与 API
│   └── services/
│       ├── spark_client.py            # 星火 API 真实调用封装
│       └── multi_agent.py             # 多智能体协同逻辑
├── frontend/
│   ├── templates/
│   │   └── index.html                 # 标签页页面
│   └── static/
│       ├── css/style.css              # 明亮活泼风格样式
│       └── js/app.js                  # 前端交互逻辑
├── data/
│   └── knowledge_base/
│       └── ai_course_intro.md         # 示例课程知识库
├── outputs/                           # 每次运行自动落盘结果
├── run.py                             # Web 启动入口
├── materials/
│   ├── http_demo.py                   # CLI 入口（保留）
│   ├── 星火SparkUltra-APIkey.txt
│   └── 赛题地址.txt
├── requirements.txt
└── ...
```

---

## 2. 核心功能

### 2.1 多智能体流程

1. 学习画像智能体：从自然语言对话中抽取并构建动态画像（≥6维）。
2. 资源生成智能体：生成 6 类个性化学习资源（文档/思维导图/练习题/阅读材料/实操案例/视频学习资料）。
3. 路径规划智能体：根据画像与资源制定学习路径及推送策略。
4. 智能辅导智能体：按“结论→原理→例子”结构答疑。
5. 学习评估智能体：基于学习路径与进度表单输出详细评估（阶段完成度/质量/风险/改进动作）。

### 2.2 前端页面

- 标签页：**学习画像 / 学习路径 / 学习评估 / 分资源独立标签**
- 明亮活泼风格：渐变背景、圆角卡片、胶囊标签、色彩强调按钮
- 学习画像、学习路径、学习评估均改为 Markdown 渲染，不再直接展示 JSON
- 支持“学习项目选择”：可选择已有项目填写学习进度，或新建项目生成学习画像与资源
- 进入软件先填写学习进度调查问卷；学习完成后可选填写测试问卷
- 仅在提交测试问卷后，才由星火生成下一次进入软件要填写的学习进度调查问卷
- 可跳过测试问卷；跳过时不会更新下一次学习进度调查问卷
- 学习画像/学习路径/学习评估在 MD 中以可读文本展示，不直接嵌入 JSON 代码块
- 新增登录态与历史记录动态侧栏（点击历史可回填并查看结果）
- 新增历史记录删除（支持从侧栏直接删除指定学习项目）
- 新增分步动态加载流程：项目选择（居中）→ 进度问卷/新建构建 → 学习画像结果页
- 各步骤新增返回功能，星火 AI 请求弹窗支持“取消请求”
- 新增移动端适配（小屏布局、横向标签滚动、按钮自适应）
- 智能辅导升级为可拖拽、可隐藏、可最小化的悬浮助手（脱离标签页）
- 智能辅导新增会话记忆与“清除记忆”功能
- Markdown 渲染增强：表格滚动优化、代码块高亮（highlight.js）、数学公式（KaTeX）、结构化导图（Markdown 大纲）

### 2.3 登录与数据保存机制

- 第一次进入会先跳转到 `/login`
- 登录页输入用户名+密码：
  - 用户不存在：自动注册并创建专属用户目录
  - 用户存在：校验密码后登录
- 支持“忘记密码”：可通过 3 个密保问题校验后重置密码
- 支持“用户中心”：可修改密码、设置/更新密保问题
- 登录后先选择学习项目：选择“已有项目”进入进度填写，选择“新建项目”进入学习方案生成
- 所有使用数据均以 JSON 保存在独立用户数据目录（默认：仓库同级目录 `../csc_learnplatform_user_data/<username>/`；可通过环境变量 `USER_DATA_DIR` 覆盖）
- 不同用户数据完全隔离

### 2.4 真实星火调用

后端在 `backend/services/spark_client.py` 中使用：

- `POST https://spark-api-open.xf-yun.com/v1/chat/completions`
- Header: `Authorization: Bearer <APIKEY>`
- Body: 标准 `model/messages/temperature` 请求体

无 mock、无假数据回填。

---

## 3. 环境与安装

### 3.1 Python 版本

- 推荐 Python 3.9+

### 3.2 安装依赖

```bash
# macOS / Windows / 通用
pip3 install -r requirements.txt

# Ubuntu 系统 Python 受管环境（如需要）
pip3 install --break-system-packages -r requirements.txt
```

---

## 4. 配置模型 API（星火 + 豆包）

默认读取 `materials/星火SoarkUltra-APIkey.txt`，格式示例：

```text
APIkey：你的密钥
接口地址：https://spark-api-open.xf-yun.com/v1/chat/completions
```

也支持环境变量覆盖（优先级更高）：

```bash
# 双模型双密钥（推荐）
export SPARK_ULTRA_API_URL="https://spark-api-open.xf-yun.com/v1/chat/completions"
export SPARK_ULTRA_API_AUTH="Bearer 你的Ultra模型密钥"
export SPARK_LITE_API_URL="https://spark-api-open.xf-yun.com/v1/chat/completions"
export SPARK_LITE_API_AUTH="Bearer 你的Lite模型密钥"
export DOUBAO_API_URL="https://ark.cn-beijing.volces.com/api/v3"
export DOUBAO_API_KEY="你的豆包密钥"
export DOUBAO_LITE_API_URL="https://ark.cn-beijing.volces.com/api/v3"
export DOUBAO_LITE_API_KEY="你的豆包Lite密钥"

# 单密钥兼容写法（可选）
export SPARK_API_URL="https://spark-api-open.xf-yun.com/v1/chat/completions"
export SPARK_API_AUTH="Bearer 你的密钥"
```

性能调优常用变量（可按模型分别配置）：

```bash
export SPARK_MAX_PARALLEL="5"
export SPARK_MAX_QPS="3"
export RESOURCE_MAX_PARALLEL="3"
export FORM_MAX_PARALLEL="2"

# 通用
export SPARK_CONNECT_TIMEOUT="10"
export SPARK_READ_TIMEOUT="240"
export SPARK_MAX_RETRIES="2"
export SPARK_STREAM="0"     # 1=启用流式

# 按模型覆盖（示例）
export SPARK_ULTRA_MAX_PARALLEL="5"
export SPARK_LITE_MAX_PARALLEL="2"
export SPARK_LITE_MAX_QPS="1"
export SPARK_LITE_STREAM="1"
export SPARK_LITE_MAX_RETRIES="4"
export DOUBAO_MAX_PARALLEL="6"
export DOUBAO_READ_TIMEOUT="180"
export DOUBAO_LITE_MAX_PARALLEL="1"
export DOUBAO_LITE_MAX_QPS="0.5"
export DOUBAO_LITE_MAX_RETRIES="5"
export DOUBAO_LITE_RETRY_INTERVAL="1.2"
export DOUBAO_LITE_READ_TIMEOUT="180"
```

> 使用 `doubao-seed-2-0-lite-260428` 时，建议同时设置 `RESOURCE_MAX_PARALLEL="1"`，避免资源生成阶段并发触发模型侧“上限 1”限流。

---

## 5. 启动方式

### 5.1 启动 Web 服务（推荐）

```bash
python3 run.py
```

浏览器访问：

```text
http://127.0.0.1:8000
```

### 5.2 CLI 方式（可选）

```bash
python3 materials/http_demo.py \
  --course "人工智能导论" \
  --topic "机器学习基础" \
  --dialogue "我是大二计算机学生，偏好图解和代码练习，每周可投入8小时" \
  --progress "目前监督学习正确率70%" \
  --output "run_cli_demo"
```

---

## 6. Web API 说明

### 6.1 生成学习方案

- `POST /api/generate`

请求体：

```json
{
  "course": "人工智能导论",
  "topic": "机器学习基础",
  "dialogue": "我是大二计算机学生，线代薄弱，偏好图解",
  "model": "4.0Ultra"
}
```

返回体（节选）：

```json
{
  "run_name": "run_20260410_165500",
  "output_dir": ".../outputs/run_20260410_165500",
  "report": {
    "profile": {},
    "resources": {},
    "learning_path": {}
  },
  "report_markdown": {}
}
```

### 6.2 智能辅导

- `POST /api/tutor`

请求体：

```json
{
  "question": "为什么要做特征归一化？",
  "topic": "机器学习基础",
  "model": "4.0Ultra",
  "profile": { "profile": { "knowledge_level": "初学" } }
}
```

### 6.3 用户信息与历史记录

- `GET /api/user/profile`：返回当前用户、历史任务列表、最新报告
- `GET /api/user/center`：返回用户中心摘要（账号时间、项目数量、密保状态）
- `POST /api/user/change-password`：登录态下修改密码（需当前密码）
- `POST /api/user/security-questions`：登录态下设置/更新 3 个密保问题
- `POST /api/auth/security-questions`：根据用户名获取密保问题（用于忘记密码）
- `POST /api/auth/reset-password`：回答密保问题后重置密码
- `GET /api/projects`：返回可选学习项目（已有 run 列表）
- `GET /api/user/run/<run_name>`：返回指定历史任务完整 JSON
- `DELETE /api/user/run/<run_name>`：删除指定历史任务（历史索引、run 文件、对应进度日志）
- `POST /api/progress/checkin`：提交问卷（`form_type=progress|test`）；仅 `test` 提交会更新下一次进度问卷

---

## 7. 输出文件

每次生成都会保存到 `outputs/<run_name>/`：

```text
outputs/<run_name>/
├── markdown/
│   ├── 学习画像.md
│   ├── 学习路径.md
│   ├── 学习进度表单.md
│   ├── 学习测试问卷.md
│   ├── 学习问卷历史.md
│   ├── 学习进度调查问卷_阶段x_第x版.md
│   ├── 学习测试问卷_阶段x_第x版.md
│   ├── 学习评估.md
│   └── AI返回总览.md
└── resources/
    ├── 课程讲解文档.md
    ├── 知识点结构化导图(Markdown大纲).md
    ├── 分层练习题(含答案与解析).md
    ├── 拓展阅读材料.md
    ├── 实操案例.md
    └── 视频学习资料.md
```

---

## 8. 常见问题

### 8.1 401/403 鉴权失败

- 检查 `APIkey` 是否有效；
- 检查是否正确拼接 `Bearer`；
- 检查账号是否有对应模型调用权限。

### 8.2 页面显示“请求失败”

- 确认后端已启动在 `8000` 端口；
- 查看终端异常信息（通常为配置文件路径或接口返回错误）。

### 8.3 生成较慢

- 当前 6 类资源按顺序生成，确保稳定性；
- 若需要提速，可改为并行请求（可作为后续优化项）。

---

## 9. 说明

- 本项目聚焦赛题核心目标：**多智能体协同 + 个性化学习资源生成 + Web交互展示**。
- 若后续接入第三方开源组件，请在比赛文档中标注来源与许可证。
