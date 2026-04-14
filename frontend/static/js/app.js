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
  progressCurrentIndex: 0,
  activeController: null,
  tutorVisible: false,
  tutorMemory: [],
};

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
  setVisible("historyCard", step !== "project");
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
    breaks: true,
  });
}

function enhanceMarkdown(container) {
  if (!container) return;
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
}

function renderMarkdownContent(rawText) {
  const raw = (rawText || "").trim();
  if (!raw) return "";
  return window.marked ? marked.parse(raw) : `<pre>${escapeHtml(raw)}</pre>`;
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

function renderResources(resources) {
  const container = byId("resources");
  const entries = Object.entries(resources || {});
  if (!entries.length) {
    container.innerHTML = "<p class='muted-text'>暂无资源</p>";
    return;
  }
  container.innerHTML = entries
    .map(([name, content]) => {
      const html = renderMarkdownContent(content || "");
      return `<article class="resource-item markdown-body"><h3>${name}</h3><div>${html}</div></article>`;
    })
    .join("");
  enhanceMarkdown(container);
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
  renderResources(report.resources || {});
  renderMarkdown("aiMarkdown", reportMarkdown.full_report_md || buildFallbackReportMarkdown(report), "暂无 AI 返回内容");
}

function renderProjectOptions(runs) {
  state.runs = runs || [];
  const select = byId("projectSelect");
  if (!state.runs.length) {
    select.innerHTML = `<option value="">暂无已有学习项目</option>`;
    return;
  }
  select.innerHTML = [
    `<option value="">请选择已有学习项目</option>`,
    ...state.runs.map(
      (item) =>
        `<option value="${item.run_name}">${escapeHtml(item.course || "未命名课程")} · ${escapeHtml(item.topic || "未命名主题")} (${escapeHtml(item.created_at || item.run_name)})</option>`,
    ),
  ].join("");
}

function renderHistory(runs) {
  const el = byId("historyList");
  if (!runs.length) {
    el.innerHTML = "<p class='meta'>暂无历史记录</p>";
    return;
  }
  el.innerHTML = runs
    .map(
      (item) => `
      <article class="history-item" data-run="${item.run_name}">
        <div class="history-main">
          <div class="title">${item.course || "未命名课程"} · ${item.topic || "未命名主题"}</div>
          <div class="meta">${item.created_at || ""}</div>
        </div>
        <button class="history-delete-btn" data-run="${item.run_name}" type="button">删除</button>
      </article>`,
    )
    .join("");

  document.querySelectorAll(".history-item").forEach((node) => {
    node.addEventListener("click", async () => {
      const runName = node.getAttribute("data-run") || "";
      byId("projectSelect").value = runName;
      await chooseExistingProject();
    });
  });

  document.querySelectorAll(".history-delete-btn").forEach((node) => {
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      const runName = node.getAttribute("data-run") || "";
      if (!runName) return;
      const ok = window.confirm("确认删除该历史记录吗？删除后不可恢复。");
      if (!ok) return;
      await deleteHistory(runName);
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

  if (qtype === "single_choice") {
    const checked = document.querySelector(".progress-answer-single:checked");
    state.progressAnswers[qid] = checked ? checked.value : "";
    return;
  }
  if (qtype === "multi_choice") {
    const values = [];
    document.querySelectorAll(".progress-answer-multi").forEach((el) => {
      if (el.checked) values.push(el.value);
    });
    state.progressAnswers[qid] = values;
    return;
  }
  if (qtype === "scale") {
    const checked = document.querySelector(".progress-answer-scale:checked");
    state.progressAnswers[qid] = checked ? checked.value : "";
    return;
  }
  state.progressAnswers[qid] = (byId("progressTextAnswer")?.value || "").trim();
}

function renderProgressQuestion() {
  const wrap = byId("progressFormWrap");
  const questions = state.progressFormTemplate?.questions || [];
  if (!questions.length) {
    wrap.innerHTML = "<p class='muted-text'>该项目暂无进度表单。</p>";
    return;
  }

  const current = Math.min(Math.max(state.progressCurrentIndex, 0), questions.length - 1);
  state.progressCurrentIndex = current;
  const question = questions[current];
  const qid = question.id || `q${current + 1}`;
  const qtype = question.type || "text";
  const requiredMark = question.required ? "（必填）" : "（选填）";
  const old = state.progressAnswers[qid];

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
  state.progressAnswers = {};
  (latestCheckin?.responses || []).forEach((item) => {
    state.progressAnswers[item.question_id] = item.answer;
  });
  renderProgressQuestion();
}

function collectProgressFormData() {
  saveCurrentProgressAnswer();
  const responses = [];
  const requiredErrors = [];
  const questions = state.progressFormTemplate?.questions || [];

  questions.forEach((q, idx) => {
    const qid = q.id || `q${idx + 1}`;
    const qtype = q.type || "text";
    const answer = state.progressAnswers[qid];
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
  byId(tabId).classList.add("active");
}

function clearResultPanels() {
  state.report = null;
  state.reportMarkdown = {};
  byId("profile").innerHTML = "";
  byId("path").innerHTML = "";
  byId("evaluate").innerHTML = "";
  byId("resources").innerHTML = "";
  byId("aiMarkdown").innerHTML = "";
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
  renderHistory(data.projects || []);
}

async function chooseExistingProject() {
  const runName = byId("projectSelect").value.trim();
  if (!runName) {
    setProjectStatus("请先从下拉框选择已有学习项目。");
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
  state.existingProgressSubmitted = false;
  state.report = data.report || {};
  state.reportMarkdown = data.report_markdown || {};
  renderProgressForm(data.report?.progress_form_template || {}, data.progress_checkins?.[0]?.checkin || null);
  byId("progressNotice").textContent = "请先填写学习进度并提交，提交后进入学习画像与完整方案页面。";
  setStep("progress");
  setProjectStatus(`已选择已有项目：${runName}`);
  setStatus("已加载进度问卷，请先提交学习进度。");
}

function chooseNewProject() {
  state.mode = "new";
  state.selectedRunName = "";
  state.existingProgressSubmitted = false;
  state.progressFormTemplate = {};
  state.progressAnswers = {};
  state.progressCurrentIndex = 0;
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
  state.selectedRunName = "";
  state.existingProgressSubmitted = false;
  setStep("project");
  setProjectStatus("请选择已有项目或新建学习项目。");
}

function goBackFromResult() {
  if (state.mode === "existing") {
    setStep("progress");
    return;
  }
  if (state.mode === "new") {
    setStep("task");
    return;
  }
  setStep("project");
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
  const checkin = collectProgressFormData();
  if (!checkin.valid) {
    setStatus("请完成所有必填题目后再提交。");
    return;
  }
  setStatus("正在提交学习进度并请求星火评估...");

  const data = await withLoading(
    "正在请求星火 AI 评估学习进度...",
    async (signal) => {
      const resp = await fetch("/api/progress/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_name: state.selectedRunName,
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
  byId("progressNotice").textContent = "学习进度已提交并完成评估。";
  setActiveTab("profile");
  setStep("result");
  setStatus("学习进度已提交，已进入学习画像页面。");
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

async function deleteHistory(runName) {
  const resp = await fetch(`/api/user/run/${encodeURIComponent(runName)}`, { method: "DELETE" });
  const data = await resp.json();
  if (!resp.ok) {
    setProjectStatus(data.error || "删除失败");
    return;
  }
  if (state.selectedRunName === runName) {
    state.selectedRunName = "";
    state.mode = "";
    clearResultPanels();
    setStep("project");
  }
  await loadProjects();
  setProjectStatus(`已删除历史记录：${runName}`);
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      byId(tab.dataset.tab).classList.add("active");
    });
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
  byId("askBtn").addEventListener("click", askTutor);
  byId("backFromTaskBtn").addEventListener("click", goBackToProjectSelection);
  byId("backFromProgressBtn").addEventListener("click", goBackToProjectSelection);
  byId("backFromResultBtn").addEventListener("click", goBackFromResult);
  byId("cancelRequestBtn").addEventListener("click", cancelCurrentRequest);
  byId("tutorToggleFab").addEventListener("click", openTutorWidget);
  byId("openTutorWidgetInlineBtn").addEventListener("click", openTutorWidget);
  byId("tutorWidgetCloseBtn").addEventListener("click", hideTutorWidget);
  byId("tutorWidgetMinBtn").addEventListener("click", toggleTutorMinimized);
  byId("clearTutorMemoryBtn").addEventListener("click", clearTutorMemory);
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
