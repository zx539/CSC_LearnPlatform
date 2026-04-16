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
};
let mermaidIdSeed = 0;
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

function setStatus(text) {
  byId("status").textContent = text;
}

function setProjectStatus(text) {
  byId("projectStatus").textContent = text;
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

function showLoading(text = "正在请求星火 AI，请稍候...", cancellable = false) {
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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
      Promise.resolve(mermaid.run({ nodes })).catch(() => {
        nodes.forEach((node) => {
          if (node.getAttribute("data-processed") === "true") return;
          node.classList.add("mermaid-failed");
        });
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
    tab.className = "tab resource-tab-dynamic";
    tab.dataset.tab = panelId;
    tab.textContent = name;
    const pathTab = tabsWrap.querySelector('.tab[data-tab="path"]');
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
        const result = await resp.json();
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
  state.progressFormTemplate = template || {};
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
  state.testFormTemplate = template || {};
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
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const tab = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (!tab) return;
  tab.classList.add("active");
  const panel = byId(tabId);
  if (!panel) return;
  panel.classList.add("active");
  panel.querySelectorAll(".mermaid[data-processed='true']").forEach((node) => {
    const source = node.dataset.mermaidSource;
    if (!source) return;
    node.textContent = source;
    node.removeAttribute("data-processed");
  });
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
  const userNameText = document.querySelector(".user-bar span")?.textContent || "";
  const userName = userNameText.replace("👤", "").trim() || "anonymous";
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
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "加载学习项目失败");
  renderProjectOptions(data.projects || []);
}

async function chooseExistingProject() {
  const runName = state.selectedRunName.trim();
  if (!runName) {
    setProjectStatus("请先在学习项目列表中选择一个项目。");
    return;
  }
  const data = await withLoading("正在动态加载已选项目与进度问卷...", async () => {
    const resp = await fetch(`/api/user/run/${encodeURIComponent(runName)}`);
    const result = await resp.json();
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
    model: byId("model").value.trim() || "4.0Ultra",
  };
  if (!payload.course || !payload.topic || !payload.dialogue) {
    setStatus("请填写必填项：课程、主题、画像对话。");
    return;
  }
  state.topic = payload.topic;
  setStatus("正在生成学习方案...");

  const data = await withLoading(
    "正在请求星火 AI 生成学习画像与学习方案...",
    async (signal) => {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || "生成失败");
      return result;
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      setStatus("已取消本次星火请求。");
      return null;
    }
    setStatus(`错误：${err.message}`);
    return null;
  });

  if (!data) return;
  state.selectedRunName = data.run_name || state.selectedRunName;
  state.testFormTemplate = data.report?.test_form_template || state.testFormTemplate || {};
  state.progressFormTemplate = data.report?.progress_form_template || state.progressFormTemplate || {};
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
    "正在请求星火 AI 评估学习进度...",
    async (signal) => {
      const resp = await fetch("/api/progress/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_name: state.selectedRunName,
          form_type: "progress",
          model: byId("model").value.trim() || "4.0Ultra",
          checkin: checkin.payload,
        }),
        signal,
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || "提交失败");
      return result;
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      setStatus("已取消本次星火评估请求。");
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
    "正在请求星火 AI 生成更新后的进度问卷和测试问卷...",
    async (signal) => {
      const resp = await fetch("/api/progress/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_name: state.selectedRunName,
          form_type: "test",
          model: byId("model").value.trim() || "4.0Ultra",
          checkin: checkin.payload,
        }),
        signal,
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || "提交失败");
      return result;
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      setStatus("已取消本次星火评估请求。");
      return null;
    }
    setStatus(`测试问卷提交失败：${err.message}`);
    return null;
  });
  if (!data) return;

  if (data.next_progress_form && typeof data.next_progress_form === "object") {
    state.report.progress_form_template = data.next_progress_form;
    state.progressFormTemplate = data.next_progress_form;
    state.progressAnswers = {};
  }
  if (data.next_test_form && typeof data.next_test_form === "object") {
    state.report.test_form_template = data.next_test_form;
    state.testFormTemplate = data.next_test_form;
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
    "正在请求星火 AI 生成辅导答案...",
    async (signal) => {
      const resp = await fetch("/api/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          topic: state.topic,
          model: byId("model").value.trim() || "4.0Ultra",
          profile: state.report.profile,
          memory: state.tutorMemory,
        }),
        signal,
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || "辅导失败");
      return result;
    },
    { cancellable: true },
  ).catch((err) => {
    if (err?.name === "AbortError") {
      byId("tutorHint").textContent = "已取消本次星火辅导请求。";
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
    const tab = event.target.closest(".tab");
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
  try {
    await loadProjects();
    setProjectStatus("请选择已有项目或新建学习项目。");
  } catch (err) {
    setProjectStatus(`项目加载失败：${err.message}`);
  }
}

boot();
