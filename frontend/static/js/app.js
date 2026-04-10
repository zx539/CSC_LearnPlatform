const state = {
  report: null,
  topic: "",
  runs: [],
};

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function byId(id) {
  return document.getElementById(id);
}

function renderJSON(targetId, value) {
  byId(targetId).innerHTML = `<pre class="json-box">${JSON.stringify(value, null, 2)}</pre>`;
}

function renderResources(resources) {
  const container = byId("resources");
  const entries = Object.entries(resources || {});
  if (!entries.length) {
    container.innerHTML = "<p>暂无资源</p>";
    return;
  }
  container.innerHTML = entries
    .map(([name, content]) => {
      const html = window.marked ? marked.parse(content || "") : `<pre>${content || ""}</pre>`;
      return `<article class="resource-item"><h3>${name}</h3><div>${html}</div></article>`;
    })
    .join("");
}

function renderReport(report) {
  state.report = report;
  renderJSON("profile", report.profile || {});
  renderResources(report.resources || {});
  renderJSON("path", report.learning_path || {});
  renderJSON("evaluate", report.evaluation || { note: "本次未提供 progress，未生成评估。" });
}

function renderHistory(runs) {
  state.runs = runs || [];
  const el = byId("historyList");
  if (!state.runs.length) {
    el.innerHTML = "<p class='meta'>暂无历史记录</p>";
    return;
  }

  el.innerHTML = state.runs
    .map(
      (item) => `
      <article class="history-item" data-run="${item.run_name}">
        <div class="title">${item.course || "未命名课程"} · ${item.topic || "未命名主题"}</div>
        <div class="meta">${item.created_at || ""}</div>
      </article>`,
    )
    .join("");

  document.querySelectorAll(".history-item").forEach((node, index) => {
    node.addEventListener("click", async () => {
      const run = state.runs[index];
      try {
        const resp = await fetch(`/api/user/run/${encodeURIComponent(run.run_name)}`);
        const data = await resp.json();
        if (!resp.ok) {
          throw new Error(data.error || "加载历史记录失败");
        }
        const req = data.request || {};
        byId("course").value = req.course || "";
        byId("topic").value = req.topic || "";
        byId("dialogue").value = req.dialogue || "";
        byId("progress").value = req.progress || "";
        byId("model").value = req.model || "4.0Ultra";
        state.topic = req.topic || "";
        if (data.report) {
          renderReport(data.report);
        }
        setStatus(`已加载历史任务：${run.run_name}`);
      } catch (err) {
        setStatus(`历史记录加载失败：${err.message}`);
      }
    });
  });
}

async function loadUserProfile() {
  try {
    const resp = await fetch("/api/user/profile");
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "加载用户信息失败");
    }
    renderHistory(data.runs || []);
    if (data.latest && data.latest.report) {
      renderReport(data.latest.report);
      const req = data.latest.request || {};
      byId("course").value = req.course || "";
      byId("topic").value = req.topic || "";
      byId("dialogue").value = req.dialogue || "";
      byId("progress").value = req.progress || "";
      byId("model").value = req.model || "4.0Ultra";
      state.topic = req.topic || "";
      setStatus("已加载上次保存的数据");
    }
  } catch (err) {
    setStatus(`用户数据加载失败：${err.message}`);
  }
}

async function generate() {
  const payload = {
    course: byId("course").value.trim(),
    topic: byId("topic").value.trim(),
    dialogue: byId("dialogue").value.trim(),
    progress: byId("progress").value.trim(),
    model: byId("model").value.trim() || "4.0Ultra",
  };
  if (!payload.course || !payload.topic || !payload.dialogue) {
    setStatus("请填写必填项：课程、主题、画像对话");
    return;
  }
  setStatus("正在真实调用星火大模型，请稍候...");
  state.topic = payload.topic;
  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "生成失败");
    }
    renderReport(data.report);
    await loadUserProfile();
    setStatus(`生成完成，结果已保存：${data.output_dir}`);
  } catch (err) {
    setStatus(`错误：${err.message}`);
  }
}

async function askTutor() {
  if (!state.report || !state.report.profile) {
    byId("tutorAnswer").textContent = "请先生成学习方案，再进行智能辅导。";
    return;
  }
  const question = byId("question").value.trim();
  if (!question) {
    byId("tutorAnswer").textContent = "请输入问题。";
    return;
  }

  byId("tutorAnswer").textContent = "正在思考中...";
  try {
    const resp = await fetch("/api/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        topic: state.topic,
        model: byId("model").value.trim() || "4.0Ultra",
        profile: state.report.profile,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "辅导失败");
    }
    const html = window.marked ? marked.parse(data.answer || "") : data.answer || "";
    byId("tutorAnswer").innerHTML = html;
  } catch (err) {
    byId("tutorAnswer").textContent = `错误：${err.message}`;
  }
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const key = tab.dataset.tab;
      byId(key).classList.add("active");
    });
  });
}

function boot() {
  initTabs();
  byId("generateBtn").addEventListener("click", generate);
  byId("askBtn").addEventListener("click", askTutor);
  loadUserProfile();
}

boot();
