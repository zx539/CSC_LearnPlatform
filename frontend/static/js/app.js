const state = {
  mode: "", // "", "new", "existing"
  step: "project", // "project" | "task" | "progress" | "result"
  report: null,
  reportMarkdown: {},
  runs: [],
  selectedRunName: "",
  existingProgressSubmitted: false,
  topic: "",
  progressFormTemplate: {},
  progressAnswers: {},
  testFormTemplate: {},
  testAnswers: {},
  formMode: "progress",
  progressCurrentIndex: 0,
  activeController: null,
  tutorVisible: false,
  tutorMemory: [],
  userCenter: null,
  avatarVersion: "",
  nickname: "",
};
let mermaidIdSeed = 0;
let mermaidRenderQueue = Promise.resolve();
const RESOURCE_DISPLAY_ORDER = [
  "课程讲解文档",
  "知识点思维导图(Mermaid)",
  "知识点结构化导图(Markdown大纲)",
  "分层练习题(含答案与解析)",
  "实操案例",
  "拓展阅读材料",
  "视频学习资料",
];

function byId(id) {
  return document.getElementById(id);
}

function getMainModel() {
  return byId("model")?.value?.trim() || "4.0Ultra";
}

function getTutorModel() {
  const tutorModel = byId("tutorModel")?.value?.trim();
  return tutorModel || getMainModel();
}

function syncTutorModel(modelValue) {
  const tutorModelEl = byId("tutorModel");
  if (!tutorModelEl) return;
  const candidate = String(modelValue || "").trim();
  const hasCandidate = Array.from(tutorModelEl.options).some((opt) => opt.value === candidate);
  tutorModelEl.value = hasCandidate ? candidate : "4.0Ultra";
}

function setStatus(text) {
  byId("status").textContent = text;
}

function setProjectStatus(text) {
  byId("projectStatus").textContent = text;
}

function setUserCenterStatus(text) {
  const el = byId("userCenterStatus");
  if (!el) return;
  el.textContent = text;
}

function getDisplayName() {
  return state.nickname || byId("userDisplayName")?.textContent?.trim() || "anonymous";
}

function normalizeQuestionType(question = {}) {
  const rawType = String(question.type || "").trim().toLowerCase();
  if (["single_choice", "single", "radio", "单选"].includes(rawType)) return "single_choice";
  if (["multi_choice", "multiple", "checkbox", "多选"].includes(rawType)) return "multi_choice";
  if (["scale", "rating", "量表"].includes(rawType)) return "scale";
  const options = Array.isArray(question.options) ? question.options.filter((item) => String(item || "").trim()) : [];
  const text = String(question.question || "").trim();
  if (!options.length) return "text";
  const allNumeric = options.every((opt) => /^\d+(\.\d+)?$/.test(String(opt).trim()));
  if (allNumeric && options.length >= 3) return "scale";
  if (text.includes("哪些") || text.includes("多选") || text.includes("可多选")) return "multi_choice";
  if (options.length > 2) return "multi_choice";
  return "single_choice";
}

function normalizeFormTemplate(template = {}) {
  const questions = Array.isArray(template.questions) ? template.questions : [];
  const normalizedQuestions = questions
    .filter((item) => item && typeof item === "object")
    .map((question, idx) => {
      const options = Array.isArray(question.options) ? question.options.filter((item) => String(item || "").trim()) : [];
      return {
        ...question,
        id: String(question.id || `q${idx + 1}`),
        question: String(question.question || "").trim() || `问题${idx + 1}`,
        type: normalizeQuestionType(question),
        options,
      };
    });
  return {
    ...template,
    questions: normalizedQuestions,
  };
}

function refreshUserAvatar(avatarUpdatedAt = "") {
  const img = byId("userAvatarImg");
  const fallback = byId("userAvatarFallback");
  if (!img || !fallback) return;
  const version = encodeURIComponent(String(avatarUpdatedAt || state.avatarVersion || Date.now()));
  img.src = `/api/user/avatar?v=${version}`;
  img.onload = () => {
    img.classList.remove("hidden-by-gate");
    fallback.classList.add("hidden-by-gate");
  };
  img.onerror = () => {
    img.classList.add("hidden-by-gate");
    fallback.classList.remove("hidden-by-gate");
  };
}

function setVisible(id, visible) {
  const el = byId(id);
  if (!el) return;
  if (visible) el.classList.remove("hidden-by-gate");
  else el.classList.add("hidden-by-gate");
}

function setStep(step) {
  state.step = step;
  setVisible("projectCard", step === "project");
  setVisible("taskCard", step === "task");
  setVisible("progressCard", step === "progress");
  setVisible("resultCard", step === "result");
  setVisible("tutorToggleFab", step !== "project");
  if (step === "project") {
    state.tutorVisible = false;
    setVisible("tutorWidget", false);
  }
  byId("mainLayout").classList.toggle("project-centered", step === "project");
}

function showLoading(text = "正在请求 AI 大模型，请稍候...", cancellable = false) {
  byId("loadingText").textContent = text;
  setVisible("cancelRequestBtn", cancellable);
  setVisible("loadingModal", true);
}

function hideLoading() {
  state.activeController = null;
  setVisible("cancelRequestBtn", false);
  setVisible("loadingModal", false);
}

async function withLoading(text, work, options = {}) {
  const { cancellable = false } = options;
  const controller = cancellable ? new AbortController() : null;
  state.activeController = controller;
  showLoading(text, cancellable);
  try {
    return await work(controller ? controller.signal : undefined);
  } finally {
    hideLoading();
  }
}

function cancelCurrentRequest() {
  if (!state.activeController) return;
  state.activeController.abort();
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readApiResponse(resp) {
  const contentType = String(resp.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return await resp.json();
  }
  const text = await resp.text();
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      // keep falling through for clear error message
    }
  }
  const preview = trimmed.replace(/\s+/g, " ").slice(0, 160);
  throw new Error(`接口返回非JSON响应（HTTP ${resp.status}）：${preview || "empty body"}`);
}

function createAbortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

async function sleepWithSignal(ms, signal) {
  if (!ms || ms <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(createAbortError());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitGenerateTask(taskId, signal) {
  let pollCount = 0;
  while (true) {
    if (signal?.aborted) throw createAbortError();
    const resp = await fetch(`/api/generate/${encodeURIComponent(taskId)}`, { method: "GET", signal });
    const result = await readApiResponse(resp);
    if (!resp.ok) throw new Error(result.error || "查询生成任务失败");
    const status = String(result.status || "").trim().toLowerCase();
    const message = String(result.message || "").trim();
    if (status === "queued" || status === "running") {
      setStatus(message || "学习方案生成中，请稍候...");
      const waitMs = Math.min(5000, 1200 + pollCount * 250);
      pollCount += 1;
      await sleepWithSignal(waitMs, signal);
      continue;
    }
    if (status === "succeeded") {
      const payload = result.result;
      if (!payload || typeof payload !== "object") {
        throw new Error("生成任务已完成，但结果为空");
      }
      return payload;
    }
    if (status === "failed") {
      throw new Error(result.error || "生成失败");
    }
    throw new Error(`未知任务状态：${status || "empty"}`);
  }
}

function configureMarkdownRenderer() {
  if (!window.marked) return;
  marked.setOptions({
    gfm: true,
    // 避免在公式块中插入 <br>，导致 KaTeX 间歇性无法识别
    breaks: false,
  });
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "default" });
  }
}

function normalizeMarkdownForRender(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return "";
  const mermaidStarts = [
    "mindmap",
    "flowchart",
    "graph",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram",
    "erDiagram",
    "gantt",
    "journey",
    "pie",
    "gitGraph",
    "timeline",
    "quadrantChart",
    "requirementDiagram",
  ];
  const looksLikeMermaid = (text) => {
    const firstLine = String(text || "").trim().split(/\r?\n/, 1)[0].trim();
    return mermaidStarts.some((prefix) => firstLine.startsWith(prefix));
  };
  const looksLikeMarkdown = (text) => /(^|\n)\s*(#{1,6}\s+\S|[-*+]\s+\S|\d+\.\s+\S|>\s+\S|```|!\[.*\]\(.*\)|\|.+\|)/.test(String(text || ""));
  const extractLeadingJson = (text) => {
    const s = String(text || "").trimStart();
    if (!s || (s[0] !== "{" && s[0] !== "[")) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      if (ch === "}" || ch === "]") depth -= 1;
      if (depth === 0) {
        return s.slice(0, i + 1);
      }
    }
    return null;
  };

  let normalized = raw;
  const decodeEscapedMarkdown = (text) => {
    let body = String(text || "").trim();
    if (!body) return body;
    const quoted = body.match(/^"(.*)"$/s);
    if (quoted) {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed === "string" && parsed.trim()) {
          body = parsed.trim();
        }
      } catch (_) {
        // ignore and keep original
      }
    }
    const hasEscapedMarkdown =
      /\\n\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s)/.test(body) ||
      (body.includes("\\n") && body.split("\n").length <= 2);
    if (!hasEscapedMarkdown) return body;
    let decoded = body
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"");
    decoded = decoded.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return decoded.trim();
  };
  normalized = decodeEscapedMarkdown(normalized);
  const looksLikeMathBlock = (text) => {
    const body = String(text || "").trim();
    if (!body) return false;
    const mathHints = /\\(?:frac|sum|int|sqrt|alpha|beta|theta|pi|sin|cos|tan|log|ln)|[_^]|=|\\cdot|\\times|\{|\}/;
    const proseHints = /[。！？；]|[a-zA-Z]{3,}\s+[a-zA-Z]{3,}/;
    return mathHints.test(body) && !proseHints.test(body);
  };
  // 将数学围栏统一转为 $$...$$；未标注语言但内容明显为公式时也自动转换
  normalized = normalized.replace(/```([^\n`]*)\s*\n?([\s\S]*?)```/g, (_, langRaw, bodyRaw) => {
    const lang = String(langRaw || "").trim().toLowerCase();
    const body = String(bodyRaw || "").trim();
    if (!body) return "";
    if (["latex", "math", "katex", "tex"].includes(lang) || (!lang && looksLikeMathBlock(body))) {
      return `$$\n${body}\n$$`;
    }
    return `\`\`\`${langRaw || ""}\n${body}\n\`\`\``;
  });

  // Lite 有时会在正文前附带 JSON，渲染时移除前置 JSON 噪音
  normalized = normalized.replace(/^```(?:json)\s*[\s\S]*?```\s*/i, "").trim();
  const leadingJson = extractLeadingJson(normalized);
  if (leadingJson) {
    const rest = normalized.slice(normalized.indexOf(leadingJson) + leadingJson.length).trim();
    if (rest && looksLikeMarkdown(rest)) {
      normalized = rest;
    }
  }

  // Lite 有时把正文包在 markdown 围栏中，直接解包避免整段被当代码高亮
  const mdFenced = normalized.match(/```(?:markdown|md)\s*([\s\S]*?)```/i);
  if (mdFenced && mdFenced[1]) {
    const body = mdFenced[1].trim();
    if (body && body.length >= Math.max(40, normalized.length * 0.35)) {
      normalized = body;
    }
  }

  const fenced = normalized.match(/^```([^\n`]*)\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) {
    const lang = (fenced[1] || "").trim().toLowerCase();
    const body = (fenced[2] || "").trim();
    if (lang === "mermaid" || looksLikeMermaid(body)) {
      normalized = `\`\`\`mermaid\n${body}\n\`\`\``;
    } else if (!lang || ["markdown", "md", "text", "txt", "plain", "plaintext"].includes(lang)) {
      normalized = body;
    } else if (looksLikeMarkdown(body)) {
      // 部分模型会用未知语言标记包裹整段 Markdown，直接解包避免整页被当代码块。
      normalized = body;
    }
  } else if (looksLikeMermaid(normalized)) {
    normalized = `\`\`\`mermaid\n${normalized}\n\`\`\``;
  }
  return normalized;
}

function getOrderedResourceEntries(resources) {
  const entries = Object.entries(resources || {});
  const order = new Map(RESOURCE_DISPLAY_ORDER.map((name, idx) => [name, idx]));
  return entries.sort((a, b) => {
    const ai = order.has(a[0]) ? order.get(a[0]) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b[0]) ? order.get(b[0]) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return String(a[0]).localeCompare(String(b[0]), "zh-CN");
  });
}

function enhanceMarkdown(container) {
  if (!container) return;
  const mermaidStarts = [
    "mindmap",
    "flowchart",
    "graph",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram",
    "erDiagram",
    "gantt",
    "journey",
    "pie",
    "gitGraph",
    "timeline",
    "quadrantChart",
    "requirementDiagram",
  ];
  const looksLikeMermaid = (text) => {
    const firstLine = String(text || "").trim().split(/\r?\n/, 1)[0].trim();
    return mermaidStarts.some((prefix) => firstLine.startsWith(prefix));
  };
  container.querySelectorAll("table").forEach((table) => {
    const parent = table.parentElement;
    if (parent && parent.classList.contains("table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
  if (window.hljs) {
    container.querySelectorAll("pre code").forEach((block) => window.hljs.highlightElement(block));
  }
  if (window.renderMathInElement) {
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      throwOnError: false,
    });
  }
  if (window.mermaid) {
    container.querySelectorAll("pre code").forEach((node) => {
      const pre = node.closest("pre");
      if (!pre || pre.dataset.mermaidRendered === "1") return;
      const classText = node.className || "";
      const content = node.textContent || "";
      const isMermaidClass = /(?:^|\s)(language-mermaid|lang-mermaid)(?:\s|$)/.test(classText);
      if (!isMermaidClass && !looksLikeMermaid(content)) return;
      const wrapper = document.createElement("div");
      wrapper.className = "mermaid";
      wrapper.textContent = content;
      wrapper.dataset.mermaidSource = content;
      wrapper.id = `mermaid-${Date.now()}-${++mermaidIdSeed}`;
      pre.dataset.mermaidRendered = "1";
      pre.replaceWith(wrapper);
    });
    const isVisible = !!(container.offsetParent || container.classList.contains("active"));
    if (!isVisible) return;
    const nodes = Array.from(container.querySelectorAll(".mermaid")).filter((node) => node.getAttribute("data-processed") !== "true");
    if (nodes.length) {
      mermaidRenderQueue = mermaidRenderQueue
        .then(() => mermaid.run({ nodes }))
        .catch(async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          try {
            await mermaid.run({ nodes });
          } catch (_) {
            nodes.forEach((node) => {
              if (node.getAttribute("data-processed") === "true") return;
              node.classList.add("mermaid-failed");
            });
          }
        });
    }
  }
}

function applyExerciseAnswerGate(panel) {
  if (!panel || panel.dataset.exerciseGateApplied === "1") return;
  const markdownRoot = panel.querySelector(".markdown-body > div");
  if (!markdownRoot) return;
  const headings = Array.from(markdownRoot.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const startHeading = headings.find((h) => /(答案|解析)/.test((h.textContent || "").trim()));
  if (!startHeading) return;

  const allNodes = Array.from(markdownRoot.childNodes);
  const startIdx = allNodes.findIndex((node) => node === startHeading);
  if (startIdx < 0) return;
  const answerNodes = allNodes.slice(startIdx);
  if (!answerNodes.length) return;

  const answerWrap = document.createElement("section");
  answerWrap.className = "exercise-answer-content hidden-by-gate";
  answerNodes.forEach((node) => answerWrap.appendChild(node));

  const gate = document.createElement("section");
  gate.className = "exercise-answer-gate";
  gate.innerHTML = `
    <label class="exercise-answer-label">
      请先填写你的答案（可简写）：
      <textarea class="exercise-answer-input" rows="4" placeholder="请输入你的作答，再点击“提交并查看答案解析”"></textarea>
    </label>
    <div class="exercise-answer-actions">
      <button type="button" class="btn-secondary exercise-answer-submit">提交并查看答案解析</button>
      <span class="exercise-answer-hint muted-text">提交后会显示标准答案与解析。</span>
    </div>
  `;

  markdownRoot.appendChild(gate);
  markdownRoot.appendChild(answerWrap);
  panel.dataset.exerciseGateApplied = "1";

  const input = gate.querySelector(".exercise-answer-input");
  const btn = gate.querySelector(".exercise-answer-submit");
  const hint = gate.querySelector(".exercise-answer-hint");
  if (!input || !btn || !hint) return;
  btn.addEventListener("click", () => {
    const value = String(input.value || "").trim();
    if (!value) {
      hint.textContent = "请先填写你的答案后再提交。";
      return;
    }
    answerWrap.classList.remove("hidden-by-gate");
    gate.classList.add("hidden-by-gate");
  });
}

function renderMarkdownContent(rawText) {
  const normalized = normalizeMarkdownForRender(rawText);
  if (!normalized) return "";
  return window.marked ? marked.parse(normalized) : `<pre>${escapeHtml(normalized)}</pre>`;
}

function renderMarkdown(targetId, markdown, empty = "暂无内容") {
  const raw = (markdown || "").trim();
  if (!raw) {
    byId(targetId).innerHTML = `<p class="muted-text">${empty}</p>`;
    return;
  }
  const html = renderMarkdownContent(raw);
  const target = byId(targetId);
  target.innerHTML = `<article class="resource-item markdown-body"><div>${html}</div></article>`;
  enhanceMarkdown(target);
}

function objectToMarkdown(value, level = 0) {
  if (value === null || value === undefined) return "暂无";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "暂无";
    return value
      .map((item) => {
        if (typeof item === "object" && item !== null) return `- \n${objectToMarkdown(item, level + 1)}`;
        return `- ${String(item)}`;
      })
      .join("\n");
  }
  const entries = Object.entries(value);
  if (!entries.length) return "暂无";
  const indent = "  ".repeat(level);
  return entries
    .map(([key, item]) => {
      if (typeof item === "object" && item !== null) return `${indent}- **${key}**:\n${objectToMarkdown(item, level + 1)}`;
      return `${indent}- **${key}**: ${String(item ?? "")}`;
    })
    .join("\n");
}

function buildFallbackMarkdown(title, value) {
  return `## ${title}\n\n${objectToMarkdown(value)}`;
}

function buildFallbackReportMarkdown(report) {
  return [
    buildFallbackMarkdown("学习画像", report?.profile || {}),
    "## 学习资源",
    ...(Object.entries(report?.resources || {}).map(([name, content]) => `### ${name}\n\n${content || ""}`)),
    buildFallbackMarkdown("学习路径", report?.learning_path || {}),
    buildFallbackMarkdown("学习进度填写表单", report?.progress_form_template || {}),
    buildFallbackMarkdown("学习评估", report?.evaluation || { summary: "暂无学习评估。" }),
  ].join("\n\n");
}

function clearDynamicResourceTabs() {
  document.querySelectorAll(".resource-tab-dynamic").forEach((el) => el.remove());
  document.querySelectorAll(".resource-panel-dynamic").forEach((el) => el.remove());
}

function renderResourcesAsTabs(resources) {
  clearDynamicResourceTabs();
  const tabsWrap = byId("resultTabs");
  const panelsWrap = document.querySelector("#resultCard .tab-panels");
  const entries = getOrderedResourceEntries(resources);
  const overview = byId("resources_panel");
  if (overview) {
    const cards = entries
      .map(([name]) => `<article class="resource-overview-item"><strong>${escapeHtml(name)}</strong><span class="muted-text">点击上方同名标签查看详情</span></article>`)
      .join("");
    overview.innerHTML = cards
      ? `<div class="resource-overview-grid">${cards}</div>`
      : "<p class='muted-text'>暂无学习资源。</p>";
  }
  entries.forEach(([name, content], idx) => {
    const panelId = `resource_${idx}`;
    const tab = document.createElement("button");
    tab.className = "side-nav-item resource-tab-dynamic";
    tab.dataset.tab = panelId;
    tab.textContent = name;
    const pathTab = tabsWrap.querySelector('.side-nav-item[data-tab="path"]');
    if (pathTab) tabsWrap.insertBefore(tab, pathTab);
    else tabsWrap.appendChild(tab);

    const panel = document.createElement("section");
    panel.id = panelId;
    panel.className = "panel resource-panel-dynamic";
    let contentText = typeof content === "string" ? content : buildFallbackMarkdown(name, content || {});
    const html = renderMarkdownContent(contentText || "");
    panel.innerHTML = `<article class="resource-item markdown-body"><div>${html}</div></article>`;
    panelsWrap.appendChild(panel);
    enhanceMarkdown(panel);
    if (String(name).includes("分层练习题")) {
      applyExerciseAnswerGate(panel);
    }
  });
}

function renderReport(report, reportMarkdown = {}) {
  state.report = report || {};
  state.reportMarkdown = reportMarkdown || {};
  renderMarkdown("profile", reportMarkdown.profile_md || buildFallbackMarkdown("学习画像", report.profile || {}), "暂无学习画像");
  renderMarkdown("path", reportMarkdown.learning_path_md || buildFallbackMarkdown("学习路径", report.learning_path || {}), "暂无学习路径");
  renderMarkdown(
    "evaluate",
    reportMarkdown.evaluation_md || buildFallbackMarkdown("学习评估", report.evaluation || { summary: "暂无学习评估。" }),
    "暂无学习评估",
  );
  renderResourcesAsTabs(report.resources || {});
}

function renderProjectOptions(runs) {
  state.runs = runs || [];
  if (state.selectedRunName && !state.runs.some((item) => item.run_name === state.selectedRunName)) {
    state.selectedRunName = "";
  }
  const el = byId("projectList");
  if (!el) return;
  if (!state.runs.length) {
    el.innerHTML = "<p class='meta project-list-empty'>暂无已有学习项目，请点击“新建学习项目”。</p>";
    return;
  }
  el.innerHTML = state.runs
    .map(
      (item) => `
      <article class="history-item ${state.selectedRunName === item.run_name ? "selected" : ""}" data-run="${item.run_name}">
        <div class="history-main">
          <div class="title">${escapeHtml(item.course || "未命名课程")} · ${escapeHtml(item.topic || "未命名主题")}</div>
          <div class="meta">创建时间：${escapeHtml(item.created_at || item.run_name || "")}</div>
          ${
            item.shared_by && (item.shared_by.nickname || item.shared_by.username)
              ? `<div class="meta">来源：${escapeHtml(item.shared_by.nickname || item.shared_by.username)} 的分享文件</div>`
              : ""
          }
        </div>
        <button class="btn-light project-delete-btn" data-delete-run="${item.run_name}" type="button">删除</button>
      </article>`,
    )
    .join("");

  el.querySelectorAll(".history-item").forEach((node) => {
    node.addEventListener("click", () => {
      const runName = node.getAttribute("data-run") || "";
      if (!runName) return;
      state.selectedRunName = runName;
      renderProjectOptions(state.runs);
      setProjectStatus(`已选择学习项目：${runName}，点击“进入已选学习项目”继续。`);
    });
  });
  el.querySelectorAll(".project-delete-btn").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const runName = node.getAttribute("data-delete-run") || "";
      if (!runName) return;
      const confirmed = window.confirm(`确认删除学习项目「${runName}」吗？删除后不可恢复。`);
      if (!confirmed) return;
      setProjectStatus(`正在删除学习项目：${runName} ...`);
      try {
        const resp = await fetch(`/api/user/run/${encodeURIComponent(runName)}`, { method: "DELETE" });
        const result = await readApiResponse(resp);
        if (!resp.ok) throw new Error(result.error || "删除失败");
        if (state.selectedRunName === runName) {
          state.selectedRunName = "";
          if (state.mode === "existing") {
            goBackToProjectSelection();
          }
        }
        await loadProjects();
        setProjectStatus(`学习项目已删除：${runName}`);
      } catch (err) {
        setProjectStatus(`删除失败：${err.message}`);
      }
    });
  });
}

function saveCurrentProgressAnswer() {
  const questions = state.progressFormTemplate?.questions || [];
  if (!questions.length) return;

  const current = Math.min(Math.max(state.progressCurrentIndex, 0), questions.length - 1);
  const q = questions[current];
  const qid = q.id || `q${current + 1}`;
  const qtype = q.type || "text";
  const answers = state.formMode === "test" ? state.testAnswers : state.progressAnswers;

  if (qtype === "single_choice") {
    const checked = document.querySelector(".progress-answer-single:checked");
    answers[qid] = checked ? checked.value : "";
    return;
  }
  if (qtype === "multi_choice") {
    const values = [];
    document.querySelectorAll(".progress-answer-multi").forEach((el) => {
      if (el.checked) values.push(el.value);
    });
    answers[qid] = values;
    return;
  }
  if (qtype === "scale") {
    const checked = document.querySelector(".progress-answer-scale:checked");
    answers[qid] = checked ? checked.value : "";
    return;
  }
  answers[qid] = (byId("progressTextAnswer")?.value || "").trim();
}

function setFormMode(mode) {
  state.formMode = mode;
  setVisible("submitProgressBtn", mode === "progress");
  setVisible("submitTestBtn", mode === "test");
  setVisible("skipTestBtn", mode === "test");
  const backBtn = byId("backFromProgressBtn");
  if (backBtn) {
    backBtn.textContent = mode === "test" ? "← 返回学习页面" : "← 返回项目选择";
  }
}

function renderProgressQuestion() {
  const wrap = byId("progressFormWrap");
  const questions = state.progressFormTemplate?.questions || [];
  if (!questions.length) {
    const text = state.formMode === "test" ? "当前暂无测试问卷，可选择跳过。" : "该项目暂无学习进度调查问卷。";
    wrap.innerHTML = `<p class='muted-text'>${text}</p>`;
    return;
  }

  const current = Math.min(Math.max(state.progressCurrentIndex, 0), questions.length - 1);
  state.progressCurrentIndex = current;
  const question = questions[current];
  const formTitle = escapeHtml(state.progressFormTemplate?.form_title || "学习进度问卷");
  const instructions = escapeHtml(state.progressFormTemplate?.instructions || "");
  const stageNo = escapeHtml(String(state.progressFormTemplate?.stage_no || ""));
  const qid = question.id || `q${current + 1}`;
  const qtype = question.type || "text";
  const requiredMark = question.required ? "（必填）" : "（选填）";
  const answers = state.formMode === "test" ? state.testAnswers : state.progressAnswers;
  const old = answers[qid];

  let answerHtml = "";
  if (qtype === "single_choice") {
    const options = (question.options || [])
      .map(
        (opt, idx) => `
        <label><input type="radio" class="progress-answer-single" name="single_${escapeHtml(qid)}" value="${escapeHtml(opt)}" ${old === opt ? "checked" : ""} /> ${String.fromCharCode(65 + idx)}. ${escapeHtml(opt)}</label>`,
      )
      .join("");
    answerHtml = `<div class="progress-options-wrap">${options}</div>`;
  } else if (qtype === "multi_choice") {
    const selected = Array.isArray(old) ? old : [];
    const options = (question.options || [])
      .map(
        (opt, idx) => `
        <label><input type="checkbox" class="progress-answer-multi" value="${escapeHtml(opt)}" ${selected.includes(opt) ? "checked" : ""} /> ${String.fromCharCode(65 + idx)}. ${escapeHtml(opt)}</label>`,
      )
      .join("");
    answerHtml = `<div class="progress-options-wrap">${options}</div>`;
  } else if (qtype === "scale") {
    const options = (question.options && question.options.length ? question.options : ["1", "2", "3", "4", "5"])
      .map(
        (opt) =>
          `<label><input type="radio" class="progress-answer-scale" name="scale_${escapeHtml(qid)}" value="${escapeHtml(opt)}" ${String(old) === String(opt) ? "checked" : ""} /> ${escapeHtml(opt)}</label>`,
      )
      .join("");
    answerHtml = `<div class="progress-scale-options">${options}</div>`;
  } else {
    answerHtml = `<textarea id="progressTextAnswer" rows="3" placeholder="请输入你的回答">${escapeHtml(old || "")}</textarea>`;
  }

  wrap.innerHTML = `
    <section class="progress-stage">
      <h3 class="progress-form-title">${formTitle}${stageNo ? `（阶段 ${stageNo}）` : ""}</h3>
      ${instructions ? `<p class="muted-text">${instructions}</p>` : ""}
      <div class="muted-text">第 ${current + 1} / ${questions.length} 题</div>
      <h3 class="progress-question-title">Q${current + 1}. ${escapeHtml(question.question || "未命名问题")} ${requiredMark}</h3>
      ${answerHtml}
      <div class="progress-nav">
        <button id="progressPrevBtn" class="btn-secondary" type="button" ${current === 0 ? "disabled" : ""}>上一题</button>
        <button id="progressNextBtn" class="btn-primary" type="button" ${current === questions.length - 1 ? "disabled" : ""}>下一题</button>
      </div>
    </section>
  `;

  byId("progressPrevBtn").addEventListener("click", () => {
    saveCurrentProgressAnswer();
    state.progressCurrentIndex = Math.max(0, state.progressCurrentIndex - 1);
    renderProgressQuestion();
  });

  byId("progressNextBtn").addEventListener("click", () => {
    saveCurrentProgressAnswer();
    state.progressCurrentIndex = Math.min(questions.length - 1, state.progressCurrentIndex + 1);
    renderProgressQuestion();
  });
}

function renderProgressForm(template = {}, latestCheckin = null) {
  state.progressFormTemplate = normalizeFormTemplate(template || {});
  state.progressCurrentIndex = 0;
  if (latestCheckin && latestCheckin.questionnaire_type === "progress") {
    const answers = {};
    (latestCheckin.responses || []).forEach((item) => {
      answers[item.question_id] = item.answer;
    });
    state.progressAnswers = answers;
  }
  setFormMode("progress");
  renderProgressQuestion();
}

function renderTestForm(template = {}, latestCheckin = null) {
  state.testFormTemplate = normalizeFormTemplate(template || {});
  if (latestCheckin && latestCheckin.questionnaire_type === "test") {
    const answers = {};
    (latestCheckin.responses || []).forEach((item) => {
      answers[item.question_id] = item.answer;
    });
    state.testAnswers = answers;
  }
}

function collectFormData(formType = "progress") {
  state.progressFormTemplate = formType === "test" ? state.testFormTemplate : state.progressFormTemplate;
  setFormMode(formType);
  saveCurrentProgressAnswer();
  const responses = [];
  const requiredErrors = [];
  const questions = state.progressFormTemplate?.questions || [];

  questions.forEach((q, idx) => {
    const qid = q.id || `q${idx + 1}`;
    const qtype = q.type || "text";
    const answers = formType === "test" ? state.testAnswers : state.progressAnswers;
    const answer = answers[qid];
    const empty =
      answer === undefined ||
      answer === null ||
      (typeof answer === "string" && answer.trim() === "") ||
      (Array.isArray(answer) && answer.length === 0);
    if (q.required && empty) requiredErrors.push(qid);
    responses.push({ question_id: qid, type: qtype, answer: answer ?? (qtype === "multi_choice" ? [] : "") });
  });

  return {
    valid: requiredErrors.length === 0,
    payload: {
      topic: state.topic,
      questionnaire_type: formType,
      responses,
    },
  };
}

function setActiveTab(tabId) {
  document.querySelectorAll(".side-nav-item").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const tab = document.querySelector(`.side-nav-item[data-tab="${tabId}"]`);
  if (!tab) return;
  tab.classList.add("active");
  const panel = byId(tabId);
  if (!panel) return;
  panel.classList.add("active");
  setVisible("openTestSurveyBtn", true);
  setVisible("openTutorWidgetInlineBtn", true);
  // Mermaid 在隐藏容器中有概率不渲染，切换到当前标签时再次增强渲染。
  enhanceMarkdown(panel);
}

function clearResultPanels() {
  state.report = null;
  state.reportMarkdown = {};
  clearDynamicResourceTabs();
  byId("profile").innerHTML = "";
  byId("resources_panel").innerHTML = "";
  byId("path").innerHTML = "";
  byId("evaluate").innerHTML = "";
  byId("question").value = "";
  byId("tutorHint").textContent = "可查看并延续之前的会话记忆。";
  renderTutorHistory();
}

function getTutorMemoryStorageKey() {
  const userName = getDisplayName();
  return `tutor-memory:${userName}`;
}

function renderTutorMemoryStatus() {
  const el = byId("tutorMemoryStatus");
  if (!el) return;
  el.textContent = `当前记忆：${state.tutorMemory.length} 条`;
}

function persistTutorMemory() {
  window.localStorage.setItem(getTutorMemoryStorageKey(), JSON.stringify(state.tutorMemory));
  renderTutorMemoryStatus();
}

function renderTutorHistory() {
  const historyEl = byId("tutorHistory");
  if (!historyEl) return;
  if (!state.tutorMemory.length) {
    historyEl.innerHTML = "<p class='tutor-history-empty'>暂无历史记忆，开始提问后会自动记录。</p>";
    return;
  }
  historyEl.innerHTML = state.tutorMemory
    .map(
      (item) => `
      <article class="tutor-msg user">
        <div class="tutor-msg-role">你</div>
        <div class="tutor-msg-content">${escapeHtml(item.question || "")}</div>
      </article>
      <article class="tutor-msg ai">
        <div class="tutor-msg-role">智能辅导</div>
        <div class="tutor-msg-content markdown-body">${renderMarkdownContent(item.answer || "")}</div>
      </article>`,
    )
    .join("");
  enhanceMarkdown(historyEl);
  historyEl.scrollTop = historyEl.scrollHeight;
}

function restoreTutorMemory() {
  const raw = window.localStorage.getItem(getTutorMemoryStorageKey());
  if (!raw) {
    state.tutorMemory = [];
    renderTutorMemoryStatus();
    renderTutorHistory();
    return;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("智能辅导记忆格式错误，请先清除浏览器本地记忆。");
  }
  state.tutorMemory = parsed
    .filter((item) => item && typeof item.question === "string" && typeof item.answer === "string")
    .slice(-20);
  renderTutorMemoryStatus();
  renderTutorHistory();
}

function clearTutorMemory() {
  state.tutorMemory = [];
  persistTutorMemory();
  renderTutorHistory();
  byId("tutorHint").textContent = "记忆已清空，接下来将从新会话开始。";
}

function openTutorWidget() {
  state.tutorVisible = true;
  const widget = byId("tutorWidget");
  widget.classList.remove("minimized");
  renderTutorHistory();
  setVisible("tutorWidget", true);
}

function hideTutorWidget() {
  state.tutorVisible = false;
  setVisible("tutorWidget", false);
}

function toggleTutorMinimized() {
  byId("tutorWidget").classList.toggle("minimized");
}

function initTutorWidgetDrag() {
  const widget = byId("tutorWidget");
  const header = byId("tutorWidgetHeader");
  if (!widget || !header) return;

  let dragging = false;
  let pointerId = null;
  let offsetX = 0;
  let offsetY = 0;

  const start = (clientX, clientY) => {
    const rect = widget.getBoundingClientRect();
    dragging = true;
    offsetX = clientX - rect.left;
    offsetY = clientY - rect.top;
    widget.style.right = "auto";
    widget.style.bottom = "auto";
    widget.style.left = `${rect.left}px`;
    widget.style.top = `${rect.top}px`;
  };

  const move = (clientX, clientY) => {
    if (!dragging) return;
    const width = widget.offsetWidth;
    const height = widget.offsetHeight;
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    const nextX = Math.min(maxX, Math.max(0, clientX - offsetX));
    const nextY = Math.min(maxY, Math.max(0, clientY - offsetY));
    widget.style.left = `${nextX}px`;
    widget.style.top = `${nextY}px`;
  };

  const end = () => {
    dragging = false;
    pointerId = null;
  };

  header.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest("button")) return;
    event.preventDefault();
    pointerId = event.pointerId;
    header.setPointerCapture(pointerId);
    start(event.clientX, event.clientY);
  });
  header.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    move(event.clientX, event.clientY);
  });
  header.addEventListener("pointerup", end);
  header.addEventListener("pointercancel", end);
}

async function loadProjects() {
  const resp = await fetch("/api/projects");
  const data = await readApiResponse(resp);
  if (!resp.ok) throw new Error(data.error || "加载学习项目失败");
  renderProjectOptions(data.projects || []);
}

function renderUserCenter(data) {
  state.userCenter = data || {};
  state.nickname = String(state.userCenter.nickname || "").trim();
  state.avatarVersion = state.userCenter.avatar_updated_at || String(Date.now());
  const displayNameEl = byId("userDisplayName");
  if (displayNameEl) {
    displayNameEl.textContent = state.nickname || state.userCenter.username || displayNameEl.textContent || "用户";
  }
  const nicknameInput = byId("nicknameInput");
  if (nicknameInput) {
    nicknameInput.value = state.nickname;
  }
  const summaryEl = byId("userCenterSummary");
  if (!summaryEl) return;
  const summary = [
    `用户名：${state.userCenter.username || "-"}`,
    `昵称：${state.nickname || "-"}`,
    `项目数量：${state.userCenter.project_count || 0}`,
    `最新项目：${state.userCenter.latest_run_name || "暂无"}`,
    `注册时间：${state.userCenter.created_at || "-"}`,
    `最近更新：${state.userCenter.updated_at || "-"}`,
    `密保状态：${state.userCenter.has_security_questions ? "已设置" : "未设置"}`,
  ].join("｜");
  summaryEl.textContent = summary;
  const projectMeta = byId("userCenterProjectMeta");
  if (projectMeta) {
    projectMeta.textContent = `项目数量：${state.userCenter.project_count || 0}`;
  }
  const projectList = byId("userCenterProjectList");
  if (projectList) {
    const names = Array.isArray(state.userCenter.project_names) ? state.userCenter.project_names : [];
    projectList.innerHTML = names.length ? names.map((name) => `<li>${escapeHtml(name)}</li>`).join("") : "<li>暂无学习项目</li>";
  }
  const questions = Array.isArray(state.userCenter.security_questions) ? state.userCenter.security_questions : [];
  const questionValues = [0, 1, 2].map((idx) => String(questions[idx]?.question || ""));
  byId("centerQuestion1").value = questionValues[0];
  byId("centerQuestion2").value = questionValues[1];
  byId("centerQuestion3").value = questionValues[2];
  refreshUserAvatar(state.userCenter.avatar_updated_at || "");
}

async function loadUserCenter() {
  const resp = await fetch("/api/user/center");
  const data = await readApiResponse(resp);
  if (!resp.ok) throw new Error(data.error || "加载用户中心失败");
  renderUserCenter(data);
}

async function openUserCenter() {
  openModal("userCenterModal");
  setUserCenterStatus("正在加载用户信息...");
  try {
    await loadUserCenter();
    setUserCenterStatus("可在此修改头像、密码与密保问题。");
  } catch (err) {
    setUserCenterStatus(`加载失败：${err.message}`);
  }
}

function openModal(modalId) {
  setVisible(modalId, true);
}

function closeModal(modalId) {
  setVisible(modalId, false);
}

async function changePassword() {
  const currentPassword = byId("centerCurrentPassword").value.trim();
  const newPassword = byId("centerNewPassword").value.trim();
  if (!currentPassword || !newPassword) {
    setUserCenterStatus("请填写旧密码和新密码。");
    return;
  }
  setUserCenterStatus("正在修改密码...");
  try {
    const resp = await fetch("/api/user/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    const data = await readApiResponse(resp);
    if (!resp.ok) throw new Error(data.error || "修改密码失败");
    byId("centerCurrentPassword").value = "";
    byId("centerNewPassword").value = "";
    closeModal("passwordModal");
    setUserCenterStatus("密码修改成功。");
    await loadUserCenter();
  } catch (err) {
    setUserCenterStatus(`修改失败：${err.message}`);
  }
}

async function saveSecurityQuestions() {
  const currentPassword = byId("centerQaPassword").value.trim();
  const questions = [
    { question: byId("centerQuestion1").value.trim(), answer: byId("centerAnswer1").value.trim() },
    { question: byId("centerQuestion2").value.trim(), answer: byId("centerAnswer2").value.trim() },
    { question: byId("centerQuestion3").value.trim(), answer: byId("centerAnswer3").value.trim() },
  ];
  if (!currentPassword || questions.some((item) => !item.question || !item.answer)) {
    setUserCenterStatus("请填写当前密码、3个问题和对应答案。");
    return;
  }
  setUserCenterStatus("正在保存密保问题...");
  try {
    const resp = await fetch("/api/user/security-questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: currentPassword, questions }),
    });
    const data = await readApiResponse(resp);
    if (!resp.ok) throw new Error(data.error || "保存密保问题失败");
    byId("centerQaPassword").value = "";
    byId("centerAnswer1").value = "";
    byId("centerAnswer2").value = "";
    byId("centerAnswer3").value = "";
    closeModal("securityQuestionModal");
    setUserCenterStatus("密保问题已保存。");
    await loadUserCenter();
  } catch (err) {
    setUserCenterStatus(`保存失败：${err.message}`);
  }
}

async function saveNickname() {
  const nickname = byId("nicknameInput").value.trim();
  if (!nickname) {
    setUserCenterStatus("昵称不能为空。");
    return;
  }
  setUserCenterStatus("正在保存昵称...");
  try {
    const resp = await fetch("/api/user/nickname", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname }),
    });
    const data = await readApiResponse(resp);
    if (!resp.ok) throw new Error(data.error || "保存昵称失败");
    state.nickname = nickname;
    byId("userDisplayName").textContent = nickname;
    setUserCenterStatus("昵称已更新。");
    await loadUserCenter();
  } catch (err) {
    setUserCenterStatus(`昵称保存失败：${err.message}`);
  }
}

function triggerAvatarUpload() {
  byId("avatarUploadInput").click();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("头像读取失败"));
    reader.readAsDataURL(file);
  });
}

async function onAvatarFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowedTypes.has(file.type)) {
    setUserCenterStatus("仅支持 PNG/JPEG/WEBP 格式头像。");
    event.target.value = "";
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    setUserCenterStatus("头像文件不能超过2MB。");
    event.target.value = "";
    return;
  }
  setUserCenterStatus("正在上传头像...");
  try {
    const avatarData = await fileToDataUrl(file);
    const resp = await fetch("/api/user/avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar_data: avatarData }),
    });
    const data = await readApiResponse(resp);
    if (!resp.ok) throw new Error(data.error || "头像上传失败");
    setUserCenterStatus("头像已更新。");
    await loadUserCenter();
  } catch (err) {
    setUserCenterStatus(`头像上传失败：${err.message}`);
  } finally {
    event.target.value = "";
  }
}

async function chooseExistingProject() {
  const runName = state.selectedRunName.trim();
  if (!runName) {
    setProjectStatus("请先在学习项目列表中选择一个项目。");
    return;
  }
  const data = await withLoading("正在动态加载已选项目与进度问卷...", async () => {
    const resp = await fetch(`/api/user/run/${encodeURIComponent(runName)}`);
    const result = await readApiResponse(resp);
    if (!resp.ok) throw new Error(result.error || "加载已有项目失败");
    return result;
  }).catch((err) => {
    setProjectStatus(err.message);
    return null;
  });
  if (!data) return;

  const req = data.request || {};
  byId("course").value = req.course || "";
  byId("topic").value = req.topic || "";
  byId("dialogue").value = req.dialogue || "";
  byId("model").value = req.model || "4.0Ultra";
  syncTutorModel(req.model || "4.0Ultra");
  state.topic = req.topic || "";
  state.selectedRunName = runName;
  state.mode = "existing";
  state.report = data.report || {};
  state.reportMarkdown = data.report_markdown || {};
  const checkins = Array.isArray(data.progress_checkins) ? data.progress_checkins : [];
  const latestProgressCheckin = checkins.find((item) => item?.form_type === "progress")?.checkin || null;
  const latestTestCheckin = checkins.find((item) => item?.form_type === "test")?.checkin || null;
  state.existingProgressSubmitted = Boolean(latestProgressCheckin);
  state.progressAnswers = {};
  state.testAnswers = {};
  state.testFormTemplate = data.report?.test_form_template || {};
  renderProgressForm(data.report?.progress_form_template || {}, latestProgressCheckin);
  renderTestForm(state.testFormTemplate, latestTestCheckin);
  if (state.existingProgressSubmitted) {
    renderReport(state.report, state.reportMarkdown);
    setActiveTab("profile");
    byId("progressNotice").textContent = "该项目学习进度问卷已提交过，无需重复填写。";
    setStep("result");
    setStatus("已进入学习页面。");
  } else {
    byId("progressNotice").textContent = "请先完成一次学习进度问卷提交。";
    setStep("progress");
    setStatus("已加载进度问卷，请先提交学习进度。");
  }
  setProjectStatus(`已进入学习项目：${runName}`);
}

async function exportShareFile() {
  if (!state.selectedRunName) {
    setProjectStatus("请先选择要分享的学习项目。");
    return;
  }
  setProjectStatus(`正在导出分享文件：${state.selectedRunName} ...`);
  try {
    const runName = state.selectedRunName;
    const resp = await fetch(`/api/share/export/${encodeURIComponent(runName)}`);
    if (!resp.ok) {
      const data = await readApiResponse(resp);
      throw new Error(data.error || "导出分享文件失败");
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${runName}_share.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setProjectStatus("分享文件已下载，可发送给其他用户导入。");
  } catch (err) {
    setProjectStatus(`导出失败：${err.message}`);
  }
}

function triggerImportShareFile() {
  byId("importShareInput").click();
}

async function onImportShareFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setProjectStatus("正在导入分享文件...");
  try {
    const text = await file.text();
    const sharePayload = JSON.parse(text);
    const resp = await fetch("/api/share/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ share_payload: sharePayload }),
    });
    const data = await readApiResponse(resp);
    if (!resp.ok) throw new Error(data.error || "导入分享文件失败");
    await loadProjects();
    state.selectedRunName = data.run_name || state.selectedRunName;
    renderProjectOptions(state.runs);
    const fromName = data.shared_by?.nickname || data.shared_by?.username || "其他用户";
    setProjectStatus(`导入成功：${data.run_name}（分享者：${fromName}）`);
  } catch (err) {
    setProjectStatus(`导入失败：${err.message}`);
  } finally {
    event.target.value = "";
  }
}

async function downloadRunDocument(format) {
  if (!state.selectedRunName) {
    setStatus("请先选择学习项目再导出文档。");
    return;
  }
  const ext = format === "docx" ? "docx" : "pdf";
  const actionText = ext === "docx" ? "Word" : "PDF";
  setStatus(`正在导出 ${actionText} ...`);
  try {
    const resp = await fetch(`/api/user/run/${encodeURIComponent(state.selectedRunName)}/document?format=${ext}`);
    if (!resp.ok) {
      const data = await readApiResponse(resp);
      throw new Error(data.error || `导出${actionText}失败`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.selectedRunName}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(`${actionText} 已下载到本地。`);
  } catch (err) {
    setStatus(`导出失败：${err.message}`);
  }
}

function chooseNewProject() {
  state.mode = "new";
  state.selectedRunName = "";
  state.existingProgressSubmitted = false;
  state.progressFormTemplate = {};
  state.progressAnswers = {};
  state.testFormTemplate = {};
  state.testAnswers = {};
  state.formMode = "progress";
  state.progressCurrentIndex = 0;
  renderProjectOptions(state.runs);
  byId("course").value = "";
  byId("topic").value = "";
  byId("dialogue").value = "";
  byId("model").value = "4.0Ultra";
  syncTutorModel("4.0Ultra");
  clearResultPanels();
  setStep("task");
  setProjectStatus("已进入新建学习项目模式，请填写信息后生成学习画像。");
  setStatus("等待输入");
}

function goBackToProjectSelection() {
  state.mode = "";
  state.step = "project";
  state.existingProgressSubmitted = false;
  renderProjectOptions(state.runs);
  setStep("project");
  setProjectStatus("请选择已有项目或新建学习项目。");
}

function goBackFromProgress() {
  if (state.mode === "existing" && state.formMode === "test") {
    setStep("result");
    setStatus("已返回学习页面。");
    return;
  }
  goBackToProjectSelection();
}

function goBackFromResult() {
  if (state.mode === "new") {
    setStep("task");
    return;
  }
  setStep("project");
}

function openTestSurveyStep() {
  if (!state.selectedRunName) {
    setStatus("未检测到项目记录，请先选择学习项目。");
    return;
  }
  const testTemplate = state.testFormTemplate || {};
  if (!Array.isArray(testTemplate.questions) || !testTemplate.questions.length) {
    setStatus("当前暂无测试问卷，可直接跳过，进度问卷不会更新。");
    return;
  }
  state.progressFormTemplate = testTemplate;
  state.progressCurrentIndex = 0;
  setFormMode("test");
  renderProgressQuestion();
  setStep("progress");
  setStatus("请根据学习完成情况填写测试问卷（可选）。");
}

function skipTestSurvey() {
  if (!state.selectedRunName) return;
  setStep("result");
  setStatus("已跳过测试问卷，下次进入软件的学习进度问卷保持不变。");
}

async function generate() {
  if (state.mode !== "new") {
    setStatus("请先点击“新建学习项目”。");
    return;
  }
  const payload = {
    course: byId("course").value.trim(),
    topic: byId("topic").value.trim(),
    dialogue: byId("dialogue").value.trim(),
    progress: "",
    model: getMainModel(),
  };
  if (!payload.course || !payload.topic || !payload.dialogue) {
    setStatus("请填写必填项：课程、主题、画像对话。");
    return;
  }
  syncTutorModel(payload.model);
  state.topic = payload.topic;
  setStatus("正在生成学习方案...");

  const data = await withLoading(
    "正在请求 AI 大模型生成学习画像与学习方案...",
    async (signal) => {
      const submitResp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const submitResult = await readApiResponse(submitResp);
      if (!submitResp.ok) throw new Error(submitResult.error || "创建生成任务失败");
      const taskId = String(submitResult.task_id || "").trim();
      if (!taskId) throw new Error("创建任务成功但未返回任务ID");
      setStatus("任务已提交，正在后台生成学习方案...");
      return await waitGenerateTask(taskId, signal);
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      setStatus("已停止等待生成结果。后台任务仍在执行，可稍后在“已有学习项目”中查看。");
      return null;
    }
    setStatus(`错误：${err.message}`);
    return null;
  });

  if (!data) return;
  state.selectedRunName = data.run_name || state.selectedRunName;
  state.testFormTemplate = normalizeFormTemplate(data.report?.test_form_template || state.testFormTemplate || {});
  state.progressFormTemplate = normalizeFormTemplate(data.report?.progress_form_template || state.progressFormTemplate || {});
  renderReport(data.report || {}, data.report_markdown || {});
  setActiveTab("profile");
  setStep("result");
  setStatus(`生成完成：${data.output_dir}`);
  await loadProjects();
}

async function submitProgress() {
  if (state.mode !== "existing") {
    setStatus("请先选择“已有学习项目”。");
    return;
  }
  if (!state.selectedRunName) {
    setStatus("未检测到学习项目，请重新选择。");
    return;
  }
  const checkin = collectFormData("progress");
  if (!checkin.valid) {
    setStatus("请完成所有必填题目后再提交。");
    return;
  }
  setStatus("正在提交学习进度调查问卷...");

  const data = await withLoading(
    "正在请求 AI 大模型评估学习进度...",
    async (signal) => {
      const resp = await fetch("/api/progress/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_name: state.selectedRunName,
          form_type: "progress",
          model: getMainModel(),
          checkin: checkin.payload,
        }),
        signal,
      });
      const result = await readApiResponse(resp);
      if (!resp.ok) throw new Error(result.error || "提交失败");
      return result;
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      setStatus("已取消本次模型评估请求。");
      return null;
    }
    setStatus(`学习进度提交失败：${err.message}`);
    return null;
  });

  if (!data) return;
  if (state.report) {
    state.report.evaluation = data.evaluation || {};
    state.reportMarkdown = data.report_markdown || state.reportMarkdown;
    renderReport(state.report, state.reportMarkdown);
  }
  state.existingProgressSubmitted = true;
  byId("progressNotice").textContent = "学习进度调查问卷已提交。你可继续学习，完成后再填写测试问卷（可选）。";
  setActiveTab("profile");
  setStep("result");
  setStatus("学习进度调查问卷已提交。");
}

async function submitTest() {
  if (!state.selectedRunName) {
    setStatus("请先选择学习项目。");
    return;
  }
  const checkin = collectFormData("test");
  if (!checkin.valid) {
    setStatus("请完成所有必填题目后再提交。");
    return;
  }
  setStatus("正在提交测试问卷并更新进度/测试问卷...");
  const data = await withLoading(
    "正在请求 AI 大模型生成更新后的进度问卷和测试问卷...",
    async (signal) => {
      const resp = await fetch("/api/progress/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_name: state.selectedRunName,
          form_type: "test",
          model: getMainModel(),
          checkin: checkin.payload,
        }),
        signal,
      });
      const result = await readApiResponse(resp);
      if (!resp.ok) throw new Error(result.error || "提交失败");
      return result;
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      setStatus("已取消本次模型评估请求。");
      return null;
    }
    setStatus(`测试问卷提交失败：${err.message}`);
    return null;
  });
  if (!data) return;

  if (data.next_progress_form && typeof data.next_progress_form === "object") {
    state.report.progress_form_template = data.next_progress_form;
    state.progressFormTemplate = normalizeFormTemplate(data.next_progress_form);
    state.progressAnswers = {};
  }
  if (data.next_test_form && typeof data.next_test_form === "object") {
    state.report.test_form_template = data.next_test_form;
    state.testFormTemplate = normalizeFormTemplate(data.next_test_form);
    state.testAnswers = {};
  }
  state.reportMarkdown = data.report_markdown || state.reportMarkdown;
  renderReport(state.report, state.reportMarkdown);
  byId("progressNotice").textContent = data.generated_next_form
    ? "测试问卷已提交，进度问卷和测试问卷已按本次结果更新并保存。"
    : "测试问卷已提交，当前未更新问卷。";
  setStep("result");
  setStatus(data.generated_next_form ? "测试问卷已提交，进度问卷和测试问卷已更新。" : "测试问卷已提交。");
}

async function askTutor() {
  if (!state.report || !state.report.profile) {
    byId("tutorHint").textContent = "请先生成或加载学习方案。";
    return;
  }
  if (state.mode === "existing" && !state.existingProgressSubmitted) {
    byId("tutorHint").textContent = "请先提交该项目学习进度，再进行智能辅导。";
    return;
  }
  const question = byId("question").value.trim();
  if (!question) {
    byId("tutorHint").textContent = "请输入问题。";
    return;
  }
  byId("tutorHint").textContent = "正在生成辅导答案...";

  const data = await withLoading(
    "正在请求 AI 大模型生成辅导答案...",
    async (signal) => {
      const resp = await fetch("/api/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          topic: state.topic,
          model: getTutorModel(),
          profile: state.report.profile,
          memory: state.tutorMemory,
        }),
        signal,
      });
      const result = await readApiResponse(resp);
      if (!resp.ok) throw new Error(result.error || "辅导失败");
      return result;
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      byId("tutorHint").textContent = "已取消本次模型辅导请求。";
      return null;
    }
    byId("tutorHint").textContent = `错误：${err.message}`;
    return null;
  });
  if (!data) return;
  state.tutorMemory.push({ question, answer: data.answer || "" });
  if (state.tutorMemory.length > 20) {
    state.tutorMemory = state.tutorMemory.slice(-20);
  }
  persistTutorMemory();
  renderTutorHistory();
  byId("question").value = "";
  byId("tutorHint").textContent = "已更新记忆，可继续追问。";
}

function initTabs() {
  const tabsWrap = byId("resultTabs");
  tabsWrap.addEventListener("click", (event) => {
    const tab = event.target.closest(".side-nav-item");
    if (!tab || !tabsWrap.contains(tab)) return;
    const tabId = tab.dataset.tab;
    if (!tabId) return;
    setActiveTab(tabId);
  });
}

async function boot() {
  configureMarkdownRenderer();
  initTabs();
  initTutorWidgetDrag();
  byId("chooseExistingBtn").addEventListener("click", chooseExistingProject);
  byId("chooseNewBtn").addEventListener("click", chooseNewProject);
  byId("generateBtn").addEventListener("click", generate);
  byId("submitProgressBtn").addEventListener("click", submitProgress);
  byId("submitTestBtn").addEventListener("click", submitTest);
  byId("skipTestBtn").addEventListener("click", skipTestSurvey);
  byId("askBtn").addEventListener("click", askTutor);
  byId("backFromTaskBtn").addEventListener("click", goBackToProjectSelection);
  byId("backFromProgressBtn").addEventListener("click", goBackFromProgress);
  byId("backFromResultBtn").addEventListener("click", goBackFromResult);
  byId("openTestSurveyBtn").addEventListener("click", openTestSurveyStep);
  byId("cancelRequestBtn").addEventListener("click", cancelCurrentRequest);
  byId("tutorToggleFab").addEventListener("click", openTutorWidget);
  byId("openTutorWidgetInlineBtn").addEventListener("click", openTutorWidget);
  byId("tutorWidgetCloseBtn").addEventListener("click", hideTutorWidget);
  byId("tutorWidgetMinBtn").addEventListener("click", toggleTutorMinimized);
  byId("clearTutorMemoryBtn").addEventListener("click", clearTutorMemory);
  byId("avatarEntryBtn").addEventListener("click", openUserCenter);
  byId("triggerAvatarUploadBtn").addEventListener("click", triggerAvatarUpload);
  byId("avatarUploadInput").addEventListener("change", onAvatarFileChange);
  byId("openChangePasswordModalBtn").addEventListener("click", () => openModal("passwordModal"));
  byId("openSecurityQuestionModalBtn").addEventListener("click", () => openModal("securityQuestionModal"));
  byId("closeUserCenterModalBtn").addEventListener("click", () => closeModal("userCenterModal"));
  byId("closePasswordModalBtn").addEventListener("click", () => closeModal("passwordModal"));
  byId("closeSecurityQuestionModalBtn").addEventListener("click", () => closeModal("securityQuestionModal"));
  byId("submitChangePasswordBtn").addEventListener("click", changePassword);
  byId("saveSecurityQuestionsBtn").addEventListener("click", saveSecurityQuestions);
  byId("saveNicknameBtn").addEventListener("click", saveNickname);
  byId("exportShareBtn").addEventListener("click", exportShareFile);
  byId("importShareBtn").addEventListener("click", triggerImportShareFile);
  byId("importShareInput").addEventListener("change", onImportShareFileChange);
  byId("downloadDocxBtn").addEventListener("click", () => downloadRunDocument("docx"));
  byId("downloadPdfBtn").addEventListener("click", () => downloadRunDocument("pdf"));
  setFormMode("progress");
  try {
    restoreTutorMemory();
  } catch (err) {
    state.tutorMemory = [];
    renderTutorMemoryStatus();
    renderTutorHistory();
    byId("tutorHint").textContent = `智能辅导记忆读取失败：${err.message}`;
  }

  setStep("project");
  refreshUserAvatar();
  try {
    await loadUserCenter();
  } catch (_) {
    // 页面初始化时不阻断主流程，用户中心可手动打开重试
  }
  try {
    await loadProjects();
    setProjectStatus("请选择已有项目或新建学习项目。");
  } catch (err) {
    setProjectStatus(`项目加载失败：${err.message}`);
  }
}

boot();
