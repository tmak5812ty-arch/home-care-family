const storageKey = "home-care-app-v1";
const shareSettingsKey = "home-care-share-settings-v1";

const seedData = {
  manuals: [
    {
      id: crypto.randomUUID(),
      title: "ガス給湯器",
      room: "屋外・浴室",
      category: "水回り",
      tags: ["お湯", "エラー", "リモコン", "凍結"],
      symptoms: ["お湯が出ない", "リモコンにエラーが出る", "冬の朝だけ給湯できない"],
      steps: [
        "ガス栓と給水元栓が開いているか確認する",
        "リモコンのエラー番号を控えて電源を入れ直す",
        "凍結の可能性がある場合は自然解凍を待ち、熱湯はかけない",
        "復旧しない場合は型番とエラー番号を控えて修理窓口へ連絡する"
      ],
      content: "型番: RUF-A2405。冬季は配管凍結に注意。長期不在時は水抜き手順を確認。"
    },
    {
      id: crypto.randomUUID(),
      title: "リビング エアコン",
      room: "リビング",
      category: "空調",
      tags: ["フィルター", "冷えない", "におい", "掃除"],
      symptoms: ["冷房の効きが悪い", "風がにおう", "運転音が大きい"],
      steps: [
        "前面パネルを開けてフィルターを外す",
        "掃除機でほこりを吸い、水洗い後に完全に乾かす",
        "室外機の前に物がないか確認する",
        "改善しない場合は内部洗浄や点検を依頼する"
      ],
      content: "フィルター掃除は2週間から1か月に1回。内部洗浄スプレーは故障リスクがあるため使用前に取説確認。"
    },
    {
      id: crypto.randomUUID(),
      title: "浴室乾燥機",
      room: "浴室",
      category: "換気・浴室",
      tags: ["フィルター", "乾かない", "換気", "カビ"],
      symptoms: ["洗濯物が乾きにくい", "換気が弱い", "浴室のカビが増えた"],
      steps: [
        "吸込口フィルターを外してほこりを取る",
        "浴室ドアの給気口を開ける",
        "乾燥運転の時間を長めに設定する",
        "異音や焦げたにおいがある場合は使用を止めて点検する"
      ],
      content: "フィルター掃除は月1回。入浴後は換気を2時間以上。"
    }
  ],
  tasks: [
    {
      id: crypto.randomUUID(),
      title: "エアコンフィルター掃除",
      area: "リビング",
      nextDate: new Date().toISOString().slice(0, 10),
      frequency: "monthly",
      kind: "掃除",
      entryType: "task",
      completed: []
    },
    {
      id: crypto.randomUUID(),
      title: "浴室乾燥機フィルター掃除",
      area: "浴室",
      nextDate: addDays(new Date(), 5).toISOString().slice(0, 10),
      frequency: "monthly",
      kind: "掃除",
      entryType: "task",
      completed: []
    },
    {
      id: crypto.randomUUID(),
      title: "給湯器まわり点検",
      area: "屋外",
      nextDate: addDays(new Date(), 12).toISOString().slice(0, 10),
      frequency: "quarterly",
      kind: "点検",
      entryType: "task",
      completed: []
    }
  ]
};

let state = loadState();
let shareSettings = loadShareSettings();
localStorage.setItem(storageKey, JSON.stringify(state));
let activeMonth = new Date();

const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");
const emptyTemplate = document.querySelector("#emptyTemplate");
const sourceCamera = document.querySelector("#sourceCamera");
const sourceFiles = document.querySelector("#sourceFiles");
const sourcePreview = document.querySelector("#sourcePreview");
const sourcePreviewList = document.querySelector("#sourcePreviewList");
const sourceFileList = document.querySelector("#sourceFileList");
const manualForm = document.querySelector("#manualForm");
const taskForm = document.querySelector("#taskForm");
const readManualPhoto = document.querySelector("#readManualPhoto");
const clearManualPhoto = document.querySelector("#clearManualPhoto");
const ocrStatus = document.querySelector("#ocrStatus");
const notificationStatus = document.querySelector("#notificationStatus");
let sourcePreviewUrl = "";
let sourcePreviewUrls = [];
let sourcePhotoPayloads = [];
let sourceFilePayloads = [];
let pendingSources = [];
let pendingSourceText = "";
let pendingMaintenanceTasks = [];
let aiStatus = { enabled: false, model: "" };
let authStatus = { required: false, authenticated: true };
let syncTimer = null;
let autoPullTimer = null;
let reminderTimer = null;
let notifiedTaskKeys = loadNotifiedTaskKeys();

document.querySelector("#todayLabel").textContent = formatLongDate(new Date());

initializeAuth();

navItems.forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

document.querySelectorAll("[data-view-jump]").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.viewJump));
});

document.querySelector("#searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get("troubleInput").trim();
  await renderResults(query);
});

sourceCamera.addEventListener("change", async () => {
  clearPhotoPreviews(false);
  const files = [...sourceCamera.files].slice(0, 12);
  if (!files.length) {
    updateSourceReadiness();
    return;
  }
  const dataUrls = await Promise.all(files.map(fileToDataUrl));
  sourcePhotoPayloads = files.map((file, index) => ({
    name: file.name || `photo-${index + 1}.jpg`,
    type: file.type || "image/jpeg",
    dataUrl: dataUrls[index]
  }));
  sourcePreviewUrls = files.map((file) => URL.createObjectURL(file));
  renderSourcePreviews();
  updateSourceReadiness();
});

sourceFiles?.addEventListener("change", async () => {
  sourceFilePayloads = [];
  const files = [...sourceFiles.files].slice(0, 8);
  if (!files.length) {
    renderSourceFiles();
    updateSourceReadiness();
    return;
  }
  sourceFilePayloads = await Promise.all(files.map(fileToSourcePayload));
  renderSourceFiles();
  updateSourceReadiness();
});

readManualPhoto.addEventListener("click", async () => {
  if (!sourcePhotoPayloads.length && !sourceFilePayloads.length) return;
  if (!aiStatus.enabled) {
    ocrStatus.textContent = "ソース読み取りにはRenderの環境変数 OPENAI_API_KEY の設定が必要です。";
    return;
  }
  readManualPhoto.disabled = true;
  ocrStatus.textContent = `写真${sourcePhotoPayloads.length}枚、ファイル${sourceFilePayloads.length}件を読み取っています。`;
  try {
    const response = await fetch("/api/ocr-manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageFiles: sourcePhotoPayloads,
        sourceFiles: sourceFilePayloads,
        familyCode: shareSettings.familyCode || ""
      })
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    applyOcrResult(data);
    const savedLabel = data.storageSaved
      ? `写真/PDF ${data.storageSaved}件をSupabaseに保存しました。`
      : data.storageError
        ? `原本保存に失敗しました。読み取り内容だけ保存できます。`
      : sourcePhotoPayloads.length || sourceFilePayloads.some((file) => file.kind === "pdf")
        ? "家族コードかSupabase設定がないため、原本保存はまだ行われていません。"
        : "";
    const maintenanceLabel = pendingMaintenanceTasks.length
      ? `メンテナンスタスク候補 ${pendingMaintenanceTasks.length}件も見つかりました。保存時にカレンダーへ追加します。`
      : "";
    ocrStatus.textContent = `AIが場所・分類・タグと内容を仮入力しました。${savedLabel} ${maintenanceLabel} 違うところだけ直して保存してください。`;
  } catch (error) {
    ocrStatus.textContent = `読み取りに失敗しました。${error.message ? ` ${error.message.slice(0, 80)}` : ""}`;
  } finally {
    readManualPhoto.disabled = false;
  }
});

clearManualPhoto.addEventListener("click", () => {
  resetSourcePreview();
});

manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get("id") || crypto.randomUUID();
  const manual = {
    id,
    title: form.get("title").trim(),
    room: form.get("room").trim(),
    category: form.get("category").trim(),
    tags: splitLinesOrComma(form.get("tags")),
    symptoms: splitLinesOrComma(form.get("symptoms")),
    steps: splitLinesOrComma(form.get("steps")),
    content: form.get("content").trim(),
    sourceText: pendingSourceTextFromForm(form.get("content")),
    sources: pendingSources
  };
  const index = state.manuals.findIndex((item) => item.id === id);
  if (index >= 0) {
    state.manuals[index] = manual;
  } else {
    state.manuals.unshift(manual);
  }
  addPendingMaintenanceTasks(manual);
  persist();
  resetManualForm();
  renderAll();
  renderResults(document.querySelector("#troubleInput").value.trim());
});

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = form.get("id") || crypto.randomUUID();
  const existing = state.tasks.find((item) => item.id === id);
  const task = {
    id,
    entryType: form.get("entryType") === "on" ? "task" : "event",
    title: form.get("title").trim(),
    area: form.get("area").trim(),
    nextDate: form.get("nextDate"),
    frequency: form.get("frequency"),
    kind: form.get("kind"),
    completed: existing?.completed || []
  };
  const index = state.tasks.findIndex((item) => item.id === id);
  if (index >= 0) {
    state.tasks[index] = task;
  } else {
    state.tasks.push(task);
  }
  persist();
  resetTaskForm();
  renderAll();
});

document.querySelector("#prevMonth").addEventListener("click", () => {
  activeMonth = new Date(activeMonth.getFullYear(), activeMonth.getMonth() - 1, 1);
  renderCalendarViews();
});

document.querySelector("#nextMonth").addEventListener("click", () => {
  activeMonth = new Date(activeMonth.getFullYear(), activeMonth.getMonth() + 1, 1);
  renderCalendarViews();
});

document.querySelector("#prevYear").addEventListener("click", () => {
  activeMonth = new Date(activeMonth.getFullYear() - 1, activeMonth.getMonth(), 1);
  renderCalendarViews();
});

document.querySelector("#nextYear").addEventListener("click", () => {
  activeMonth = new Date(activeMonth.getFullYear() + 1, activeMonth.getMonth(), 1);
  renderCalendarViews();
});

document.querySelector("#exportData").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `home-care-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

document.querySelector("#importData").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const imported = JSON.parse(await file.text());
  if (!Array.isArray(imported.manuals) || !Array.isArray(imported.tasks)) {
    alert("読み込める形式ではありません。");
    return;
  }
  state = normalizeState(imported);
  persist();
  renderAll();
  event.target.value = "";
});

document.querySelector("#refreshAiStatus").addEventListener("click", async () => {
  await renderAiSettings();
});

document.querySelector("#shareSettingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  shareSettings = {
    shareUrl: form.get("shareUrl").trim(),
    familyCode: form.get("familyCode").trim(),
    autoSync: form.get("autoSync") === "on"
  };
  localStorage.setItem(shareSettingsKey, JSON.stringify(shareSettings));
  renderShareSettings("共有設定を保存しました。");
  scheduleAutoPull();
});

document.querySelector("#pullSharedData").addEventListener("click", async () => {
  await pullSharedData();
});

document.querySelector("#pushSharedData").addEventListener("click", async () => {
  await pushSharedData();
});

document.querySelector("#enableNotifications").addEventListener("click", async () => {
  await enableNotifications();
});

document.querySelector("#cancelManualEdit").addEventListener("click", () => {
  resetManualForm();
});

document.querySelector("#cancelTaskEdit").addEventListener("click", () => {
  resetTaskForm();
});

taskForm.elements.entryType.addEventListener("change", () => {
  document.querySelector("#taskSubmitButton").textContent = taskForm.elements.entryType.checked ? "タスクを保存" : "予定を保存";
});

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const { action: name, id } = action.dataset;
  if (name === "complete-task") completeTask(id);
  if (name === "toggle-task") toggleTask(id);
  if (name === "delete-task") deleteTask(id);
  if (name === "delete-manual") deleteManual(id);
  if (name === "edit-manual") editManual(id);
  if (name === "edit-task") editTask(id);
  if (name === "quick-add-task") quickAddTask();
  if (name === "add-task-date") quickAddTask(id);
  if (name === "jump-month") {
    activeMonth = parseLocalDate(id);
    renderCalendarViews();
  }
});

renderAll();
renderAiSettings();
renderShareSettings();
scheduleAutoPull();
renderResults("");
renderNotificationStatus();
scheduleReminders();

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return normalizeState(structuredClone(seedData));
  try {
    return normalizeState(JSON.parse(saved));
  } catch {
    return normalizeState(structuredClone(seedData));
  }
}

function persist() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(storageKey, JSON.stringify(state));
  queueSharedSync();
}

function normalizeState(rawState) {
  return {
    manuals: (rawState.manuals || []).map(({ attachments, ...manual }) => ({
      id: manual.id || crypto.randomUUID(),
      title: manual.title || "",
      room: manual.room || "",
      category: manual.category || "",
      tags: Array.isArray(manual.tags) ? manual.tags : [],
      symptoms: Array.isArray(manual.symptoms) ? manual.symptoms : [],
      steps: Array.isArray(manual.steps) ? manual.steps : [],
      content: manual.content || "",
      sourceText: manual.sourceText || "",
      sources: Array.isArray(manual.sources) ? manual.sources.map(normalizeSource) : []
    })),
    tasks: (rawState.tasks || []).map((task) => ({
      id: task.id || crypto.randomUUID(),
      title: task.title || "",
      area: task.area || "",
      nextDate: task.nextDate || toDateKey(new Date()),
      frequency: task.frequency || "none",
      kind: task.kind || "掃除",
      entryType: task.entryType || "task",
      sourceManualId: task.sourceManualId || "",
      note: task.note || "",
      completed: Array.isArray(task.completed) ? task.completed : []
    })),
    updatedAt: rawState.updatedAt || ""
  };
}

function normalizeSource(source) {
  return {
    id: source.id || crypto.randomUUID(),
    type: source.type || "file",
    name: source.name || "ソース",
    storagePath: source.storagePath || "",
    mimeType: source.mimeType || "",
    bucket: source.bucket || "",
    createdAt: source.createdAt || ""
  };
}

function normalizeMaintenanceTasks(tasks) {
  return tasks
    .map((task) => ({
      title: String(task.title || "").trim(),
      area: String(task.area || "").trim(),
      kind: ["掃除", "点検", "交換", "連絡"].includes(task.kind) ? task.kind : "点検",
      frequency: ["none", "weekly", "monthly", "quarterly", "yearly"].includes(task.frequency) ? task.frequency : "none",
      nextDate: /^\d{4}-\d{2}-\d{2}$/.test(String(task.nextDate || "")) ? task.nextDate : toDateKey(new Date()),
      note: String(task.note || "").trim()
    }))
    .filter((task) => task.title);
}

function addPendingMaintenanceTasks(manual) {
  if (!pendingMaintenanceTasks.length) return;
  pendingMaintenanceTasks.forEach((candidate) => {
    const task = {
      id: crypto.randomUUID(),
      entryType: "task",
      title: candidate.title,
      area: candidate.area || manual.room || "",
      nextDate: candidate.nextDate || toDateKey(new Date()),
      frequency: candidate.frequency || "none",
      kind: candidate.kind || "点検",
      sourceManualId: manual.id,
      note: candidate.note || `取説「${manual.title}」から自動追加`,
      completed: []
    };
    const exists = state.tasks.some((item) =>
      item.sourceManualId === manual.id
      && item.title === task.title
      && item.frequency === task.frequency
    );
    if (!exists) state.tasks.push(task);
  });
}

async function renderAiSettings() {
  const status = document.querySelector("#aiSettingsStatus");
  status.textContent = "AI回答: 確認中";
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    aiStatus = {
      enabled: Boolean(data.aiEnabled),
      model: data.aiModel || ""
    };
    const storageLabel = data.sharedStorage === "supabase" ? "共有保存: Supabase" : "共有保存: 一時ファイル";
    status.textContent = aiStatus.enabled
      ? `AI回答: 有効 / ${aiStatus.model} / ${storageLabel}`
      : `AI回答: サーバー未設定 / ${storageLabel}`;
  } catch (error) {
    aiStatus = { enabled: false, model: "" };
    status.textContent = "AI回答: 状態確認に失敗";
  }
}

function loadShareSettings() {
  const saved = localStorage.getItem(shareSettingsKey);
  if (!saved) return { shareUrl: "", familyCode: "", autoSync: false };
  try {
    return { shareUrl: "", familyCode: "", autoSync: false, ...JSON.parse(saved) };
  } catch {
    return { shareUrl: "", familyCode: "", autoSync: false };
  }
}

function renderShareSettings(message = "") {
  document.querySelector("#shareUrlInput").value = shareSettings.shareUrl || "";
  document.querySelector("#familyCodeInput").value = shareSettings.familyCode || "";
  document.querySelector("#autoSyncInput").checked = Boolean(shareSettings.autoSync);
  const baseStatus = shareSettings.familyCode
    ? `共有: 設定済み${shareSettings.autoSync ? " / 自動同期" : ""}`
    : "共有: 未設定";
  document.querySelector("#shareStatus").textContent = message || baseStatus;
}

function queueSharedSync() {
  if (!shareSettings.autoSync || !shareSettings.familyCode) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    pushSharedData({ silent: true });
  }, 900);
}

function scheduleAutoPull() {
  if (!shareSettings.autoSync || !shareSettings.familyCode) return;
  clearTimeout(autoPullTimer);
  autoPullTimer = setTimeout(() => pullSharedData({ silent: true }), 300);
}

function shareEndpoint() {
  const base = (shareSettings.shareUrl || window.location.origin).replace(/\/$/, "");
  const code = encodeURIComponent(shareSettings.familyCode || "");
  return `${base}/api/shared-data?family=${code}`;
}

async function pullSharedData(options = {}) {
  if (!shareSettings.familyCode) {
    renderShareSettings("家族コードを入力してください。");
    return;
  }

  if (!options.silent) renderShareSettings("共有データを取り込んでいます。");
  try {
    const response = await fetch(shareEndpoint());
    if (response.status === 404) {
      if (!options.silent) renderShareSettings("共有データはまだありません。先に共有へ保存してください。");
      return;
    }
    if (!response.ok) throw new Error(await response.text());
    const shared = await response.json();
    const remoteState = normalizeState(shared);
    if (!state.updatedAt || !remoteState.updatedAt || remoteState.updatedAt >= state.updatedAt) {
      state = remoteState;
      localStorage.setItem(storageKey, JSON.stringify(state));
      renderAll();
      await renderResults(document.querySelector("#troubleInput").value.trim());
      renderShareSettings(options.silent ? "共有データを自動取り込みしました。" : "共有データを取り込みました。");
    } else if (!options.silent) {
      renderShareSettings("手元のデータの方が新しいため、取り込みませんでした。");
    }
  } catch (error) {
    if (!options.silent) renderShareSettings(`取り込みに失敗しました。${error.message ? ` ${error.message.slice(0, 80)}` : ""}`);
  }
}

async function pushSharedData(options = {}) {
  if (!shareSettings.familyCode) {
    renderShareSettings("家族コードを入力してください。");
    return;
  }

  if (!options.silent) renderShareSettings("共有へ保存しています。");
  try {
    const response = await fetch(shareEndpoint(), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...state,
        updatedAt: state.updatedAt || new Date().toISOString()
      })
    });
    if (!response.ok) throw new Error(await response.text());
    renderShareSettings(options.silent ? "共有へ自動保存しました。" : "共有へ保存しました。");
  } catch (error) {
    renderShareSettings(`共有保存に失敗しました。${error.message ? ` ${error.message.slice(0, 80)}` : ""}`);
  }
}

function switchView(viewName) {
  views.forEach((view) => view.classList.toggle("active", view.id === viewName));
  navItems.forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
}

function renderAll() {
  renderManuals();
  renderTasks();
  renderCalendarViews();
  renderMiniCalendar();
  renderUpcoming();
  renderTodayTasks();
  document.querySelector("#manualCount").textContent = `${state.manuals.length}件`;
  scheduleReminders();
}

async function renderResults(query) {
  const results = document.querySelector("#results");
  const resultCount = document.querySelector("#resultCount");
  results.innerHTML = "";

  const matches = rankManuals(query).slice(0, 5);
  resultCount.textContent = query ? "判定中" : "おすすめ";

  if (!matches.length && !(query && aiStatus.enabled && state.manuals.length)) {
    results.append(emptyTemplate.content.cloneNode(true));
    resultCount.textContent = query ? "0件" : "おすすめ";
    return;
  }

  if (query && aiStatus.enabled) {
    results.append(statusCard("AIが登録済み取説を読んで判断しています。"));
    try {
      const sourceManuals = state.manuals;
      const answer = await generateAiAnswer(query, sourceManuals);
      results.innerHTML = "";
      results.append(aiAnswerCard(answer));
      resultCount.textContent = "AI回答";
    } catch (error) {
      results.innerHTML = "";
      results.append(statusCard(`AI回答に失敗しました。簡易検索に切り替えます。${error.message ? ` ${error.message}` : ""}`));
      resultCount.textContent = `${matches.length}件`;
    }
  } else {
    resultCount.textContent = query ? `${matches.length}件` : "おすすめ";
    if (query) {
      results.append(statusCard("サーバーAIが未設定のため、簡易検索で表示しています。"));
    }
  }

  matches.forEach((match, index) => {
    const manual = match.manual;
    const article = document.createElement("article");
    article.className = `result-card ${index === 0 ? "best" : ""}`;
    article.innerHTML = `
      <div class="card-top">
        <div>
          <h3 class="card-title">${escapeHtml(manual.title)}</h3>
          <p class="meta-line">${escapeHtml(manual.room)} / ${escapeHtml(manual.category)}</p>
        </div>
        <span class="badge">${index === 0 ? "最有力" : `関連度 ${match.score}`}</span>
      </div>
      <ol class="steps">${manual.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
      <p class="meta-line">${escapeHtml(manual.content || "メモなし")}</p>
      <div class="tag-row">${manual.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
    `;
    results.append(article);
  });
}

async function generateAiAnswer(query, manuals) {
  const sourceText = manuals.map((manual, index) => `
【資料${index + 1}】
設備名: ${manual.title}
場所: ${manual.room}
分類: ${manual.category}
タグ: ${(manual.tags || []).join("、")}
よくある症状: ${(manual.symptoms || []).join("、")}
解決手順:
${(manual.steps || []).map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join("\n")}
メモ: ${manual.content || "なし"}
ソース本文:
${manual.sourceText || manual.content || "なし"}
  `.trim()).join("\n\n");

  const response = await fetch("/api/ai-answer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      sourceText
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message.slice(0, 120));
  }

  return response.json();
}

function parseAiPayload(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      answer: parsed.answer || text,
      diagram: parsed.diagram || { title: "", nodes: [] }
    };
  } catch {
    return {
      answer: text,
      diagram: { title: "", nodes: [] }
    };
  }
}

function aiAnswerCard(payload) {
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const article = document.createElement("article");
  article.className = "result-card best ai-card";
  article.innerHTML = `
    <div class="card-top">
      <div>
        <h3 class="card-title">AIによる判断</h3>
        <p class="meta-line">登録済み取説データを根拠に生成</p>
      </div>
      <span class="badge">AI</span>
    </div>
    <div class="ai-answer">${formatAnswer(payload.answer)}</div>
    ${sources.length ? `<p class="meta-line">根拠: ${sources.map(escapeHtml).join("、")}</p>` : ""}
    ${diagramMarkup(payload.diagram)}
  `;
  return article;
}

function diagramMarkup(diagram) {
  if (!diagram || !Array.isArray(diagram.nodes) || !diagram.nodes.length) return "";
  const nodes = diagram.nodes.slice(0, 8);
  return `
    <section class="diagram" aria-label="図解">
      <h4>${escapeHtml(diagram.title || "確認の流れ")}</h4>
      <div class="diagram-flow">
        ${nodes.map((node, index) => `
          <div class="diagram-step ${escapeHtml(node.kind)}">
            <span class="diagram-index">${index + 1}</span>
            <div>
              <strong>${escapeHtml(node.label)}</strong>
              <p>${escapeHtml(node.detail)}</p>
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function statusCard(message) {
  const article = document.createElement("article");
  article.className = "result-card";
  article.innerHTML = `<p class="meta-line">${escapeHtml(message)}</p>`;
  return article;
}

function rankManuals(query) {
  if (!query) {
    return state.manuals.map((manual, index) => ({ manual, score: state.manuals.length - index }));
  }

  const terms = tokenize(query);
  return state.manuals
    .map((manual) => {
      const searchable = [
        manual.title,
        manual.room,
        manual.category,
        manual.content,
        manual.sourceText,
        ...manual.tags,
        ...manual.symptoms,
        ...manual.steps
      ].join(" ").toLowerCase();

      const score = terms.reduce((total, term) => {
        if (!term) return total;
        if (searchable.includes(term)) return total + Math.max(3, term.length);
        return total;
      }, 0);

      const symptomBonus = manual.symptoms.some((symptom) => query.includes(symptom) || symptom.includes(query)) ? 8 : 0;
      return { manual, score: score + symptomBonus };
    })
    .filter((entry) => entry.score >= 4)
    .sort((a, b) => b.score - a.score);
}

function renderManuals() {
  const list = document.querySelector("#manualList");
  list.innerHTML = "";
  if (!state.manuals.length) {
    list.append(emptyTemplate.content.cloneNode(true));
    return;
  }

  state.manuals.forEach((manual) => {
    const card = document.createElement("article");
    card.className = "manual-card";
    card.innerHTML = `
      <div class="card-top">
        <div>
          <h3 class="card-title">${escapeHtml(manual.title)}</h3>
          <p class="meta-line">${escapeHtml(manual.room)} / ${escapeHtml(manual.category)}</p>
        </div>
        <div class="task-actions">
          <button class="small-button" data-action="edit-manual" data-id="${manual.id}" type="button">編集</button>
          <button class="small-button danger-button" data-action="delete-manual" data-id="${manual.id}" type="button">削除</button>
        </div>
      </div>
      <p class="meta-line">症状: ${manual.symptoms.map(escapeHtml).join("、")}</p>
      <p class="meta-line">手順: ${manual.steps.slice(0, 2).map(escapeHtml).join(" / ")}${manual.steps.length > 2 ? " ..." : ""}</p>
      ${manual.sources.length ? `<p class="meta-line">保存済み原本: ${manual.sources.length}件</p>` : ""}
      <div class="tag-row">${manual.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
    `;
    list.append(card);
  });
}

function renderTasks() {
  const list = document.querySelector("#taskList");
  list.innerHTML = "";
  const sorted = [...state.tasks].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  if (!sorted.length) {
    list.append(emptyTemplate.content.cloneNode(true));
    return;
  }

  sorted.forEach((task) => {
    const card = document.createElement("article");
    card.className = "task-card";
    card.innerHTML = taskMarkup(task, true);
    list.append(card);
  });
}

function renderUpcoming() {
  const list = document.querySelector("#upcomingList");
  const weekCount = document.querySelector("#weekCount");
  list.innerHTML = "";
  const today = startOfDay(new Date());
  const inTwoWeeks = addDays(today, 14);
  const upcoming = state.tasks
    .filter((task) => parseLocalDate(task.nextDate) <= inTwoWeeks)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    .slice(0, 6);

  const thisWeek = state.tasks.filter((task) => {
    const date = parseLocalDate(task.nextDate);
    return date >= today && date <= addDays(today, 7);
  }).length;

  weekCount.textContent = `${thisWeek}件`;

  if (!upcoming.length) {
    list.append(emptyTemplate.content.cloneNode(true));
    return;
  }

  upcoming.forEach((task) => {
    const card = document.createElement("article");
    card.className = "task-card";
    card.innerHTML = taskMarkup(task, false);
    list.append(card);
  });
}

function renderTodayTasks() {
  const list = document.querySelector("#todayTaskList");
  if (!list) return;
  list.innerHTML = "";
  const todayKey = toDateKey(new Date());
  const tasks = state.tasks
    .filter((task) => task.entryType !== "event" && task.nextDate <= todayKey)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate));

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact-empty";
    empty.innerHTML = "<strong>今日の予定はありません</strong><span>カレンダーから追加できます。</span>";
    list.append(empty);
    return;
  }

  tasks.forEach((task) => {
    const row = document.createElement("article");
    row.className = `today-task ${isOverdue(task) ? "overdue" : ""}`;
    row.innerHTML = `
      <button class="check-button" data-action="toggle-task" data-id="${task.id}" type="button" aria-label="${escapeHtml(task.title)}を完了">✓</button>
      <div>
        <strong>${escapeHtml(task.title)}</strong>
        <span>${escapeHtml(task.area)} / ${task.nextDate < todayKey ? "期限切れ" : "今日"} / ${frequencyLabel(task.frequency)}</span>
      </div>
      <button class="small-button" data-action="edit-task" data-id="${task.id}" type="button">編集</button>
    `;
    list.append(row);
  });
}

function renderCalendar() {
  const grid = document.querySelector("#calendarGrid");
  const monthLabel = document.querySelector("#monthLabel");
  grid.innerHTML = "";

  const year = activeMonth.getFullYear();
  const month = activeMonth.getMonth();
  monthLabel.textContent = `${year}年 ${month + 1}月`;

  const firstDay = new Date(year, month, 1);
  const start = addDays(firstDay, -firstDay.getDay());
  const todayKey = toDateKey(new Date());

  for (let i = 0; i < 42; i += 1) {
    const date = addDays(start, i);
    const dateKey = toDateKey(date);
    const dayTasks = state.tasks.filter((task) => task.nextDate === dateKey);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = [
      "day-cell",
      date.getMonth() !== month ? "outside" : "",
      dateKey === todayKey ? "today" : ""
    ].filter(Boolean).join(" ");

    cell.innerHTML = `
      <span class="day-number">${date.getDate()}${dayTasks.length ? `<span>${dayTasks.length}件</span>` : ""}</span>
      ${dayTasks.map((task) => `<span class="event-pill ${task.entryType === "event" ? "appointment" : ""} ${task.entryType !== "event" && isOverdue(task) ? "overdue" : ""}">${escapeHtml(task.title)}</span>`).join("")}
    `;
    cell.dataset.action = "add-task-date";
    cell.dataset.id = dateKey;
    grid.append(cell);
  }
}

function renderCalendarViews() {
  renderCalendar();
  renderYearOverview();
}

function renderYearOverview() {
  const grid = document.querySelector("#yearOverviewGrid");
  const label = document.querySelector("#yearOverviewLabel");
  if (!grid || !label) return;
  grid.innerHTML = "";
  const year = activeMonth.getFullYear();
  label.textContent = `${year}年`;
  for (let month = 0; month < 12; month += 1) {
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    const count = state.tasks.filter((task) => {
      const date = parseLocalDate(task.nextDate);
      return date >= monthStart && date <= monthEnd;
    }).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `year-month ${month === activeMonth.getMonth() ? "active" : ""}`;
    button.dataset.action = "jump-month";
    button.dataset.id = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    button.innerHTML = `<strong>${month + 1}月</strong><span>${count}件</span>`;
    grid.append(button);
  }
}

function renderMiniCalendar() {
  const grid = document.querySelector("#miniCalendarGrid");
  const label = document.querySelector("#miniMonthLabel");
  if (!grid || !label) return;
  grid.innerHTML = "";
  const todayKey = toDateKey(new Date());
  const year = activeMonth.getFullYear();
  const month = activeMonth.getMonth();
  label.textContent = `${month + 1}月`;
  const firstDay = new Date(year, month, 1);
  const start = addDays(firstDay, -firstDay.getDay());

  for (let i = 0; i < 42; i += 1) {
    const date = addDays(start, i);
    const dateKey = toDateKey(date);
    const count = state.tasks.filter((task) => task.nextDate === dateKey).length;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = [
      "mini-day",
      date.getMonth() !== month ? "outside" : "",
      dateKey === todayKey ? "today" : "",
      count ? "has-task" : ""
    ].filter(Boolean).join(" ");
    cell.dataset.action = "add-task-date";
    cell.dataset.id = dateKey;
    cell.innerHTML = `<span>${date.getDate()}</span>${count ? `<i>${count}</i>` : ""}`;
    grid.append(cell);
  }
}

function taskMarkup(task, withActions) {
  const kindClass = {
    "掃除": "cleaning",
    "点検": "check",
    "交換": "replace",
    "連絡": "contact"
  }[task.kind] || "";

  return `
    <div class="card-top">
      <div>
        <h3 class="card-title">${escapeHtml(task.title)}</h3>
        <p class="meta-line">${escapeHtml(task.area)} / ${task.entryType === "event" ? "予定" : "次回"} ${formatShortDate(task.nextDate)} / ${frequencyLabel(task.frequency)}</p>
      </div>
      <span class="badge ${task.entryType === "event" ? "appointment" : kindClass}">${task.entryType === "event" ? "予定" : escapeHtml(task.kind)}</span>
    </div>
    ${withActions ? `
      <div class="task-actions">
        ${task.entryType === "event" ? "" : `<button class="small-button check-action" data-action="toggle-task" data-id="${task.id}" type="button">✓ 完了</button>`}
        <button class="small-button" data-action="edit-task" data-id="${task.id}" type="button">編集</button>
        <button class="small-button danger-button" data-action="delete-task" data-id="${task.id}" type="button">削除</button>
      </div>
    ` : ""}
  `;
}

function editManual(id) {
  const manual = state.manuals.find((item) => item.id === id);
  if (!manual) return;
  manualForm.elements.id.value = manual.id;
  manualForm.elements.title.value = manual.title;
  manualForm.elements.room.value = manual.room;
  manualForm.elements.category.value = manual.category;
  manualForm.elements.tags.value = manual.tags.join("、");
  manualForm.elements.symptoms.value = manual.symptoms.join("\n");
  manualForm.elements.steps.value = manual.steps.join("\n");
  manualForm.elements.content.value = manual.content;
  pendingSources = manual.sources || [];
  pendingSourceText = manual.sourceText || "";
  pendingMaintenanceTasks = [];
  document.querySelector("#manualSubmitButton").textContent = "取説を更新";
  document.querySelector("#cancelManualEdit").hidden = false;
  switchView("manuals");
  manualForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetManualForm() {
  manualForm.reset();
  manualForm.elements.id.value = "";
  pendingSources = [];
  pendingSourceText = "";
  pendingMaintenanceTasks = [];
  document.querySelector("#manualSubmitButton").textContent = "取説を保存";
  document.querySelector("#cancelManualEdit").hidden = true;
  resetSourcePreview();
}

function editTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  taskForm.elements.id.value = task.id;
  taskForm.elements.title.value = task.title;
  taskForm.elements.area.value = task.area;
  taskForm.elements.nextDate.value = task.nextDate;
  taskForm.elements.frequency.value = task.frequency;
  taskForm.elements.kind.value = task.kind;
  taskForm.elements.entryType.checked = task.entryType !== "event";
  document.querySelector("#taskSubmitButton").textContent = task.entryType === "event" ? "予定を更新" : "タスクを更新";
  document.querySelector("#cancelTaskEdit").hidden = false;
  switchView("calendar");
  taskForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetTaskForm() {
  taskForm.reset();
  taskForm.elements.id.value = "";
  taskForm.elements.entryType.checked = true;
  document.querySelector("#taskSubmitButton").textContent = "タスクを保存";
  document.querySelector("#cancelTaskEdit").hidden = true;
}

function quickAddTask(dateKey = "") {
  resetTaskForm();
  taskForm.elements.nextDate.value = dateKey || toDateKey(new Date());
  switchView("calendar");
  taskForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function toggleTask(id) {
  completeTask(id);
}

function completeTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  if (task.entryType === "event") return;
  task.completed.push(new Date().toISOString());
  if (task.frequency === "none") {
    state.tasks = state.tasks.filter((item) => item.id !== id);
  } else {
    task.nextDate = toDateKey(nextDateFrom(task.nextDate, task.frequency));
  }
  persist();
  renderAll();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  persist();
  renderAll();
}

function deleteManual(id) {
  state.manuals = state.manuals.filter((manual) => manual.id !== id);
  persist();
  renderAll();
  renderResults(document.querySelector("#troubleInput").value.trim());
}

function nextDateFrom(dateKey, frequency) {
  const date = parseLocalDate(dateKey);
  if (frequency === "weekly") return addDays(date, 7);
  if (frequency === "monthly") return new Date(date.getFullYear(), date.getMonth() + 1, date.getDate());
  if (frequency === "quarterly") return new Date(date.getFullYear(), date.getMonth() + 3, date.getDate());
  if (frequency === "yearly") return new Date(date.getFullYear() + 1, date.getMonth(), date.getDate());
  return date;
}

function splitLinesOrComma(value) {
  return String(value)
    .split(/[\n,、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resetSourcePreview() {
  clearPhotoPreviews();
  sourceFilePayloads = [];
  if (sourceFiles) sourceFiles.value = "";
  renderSourceFiles();
  updateSourceReadiness(true);
}

function clearPhotoPreviews(clearInput = true) {
  if (sourcePreviewUrl) {
    URL.revokeObjectURL(sourcePreviewUrl);
  }
  sourcePreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  sourcePreviewUrl = "";
  sourcePreviewUrls = [];
  sourcePhotoPayloads = [];
  sourcePreview.removeAttribute("src");
  sourcePreview.hidden = true;
  sourcePreviewList.innerHTML = "";
  if (clearInput && sourceCamera) sourceCamera.value = "";
}

function renderSourcePreviews() {
  sourcePreviewList.innerHTML = "";
  sourcePreviewUrls.forEach((url, index) => {
    const figure = document.createElement("figure");
    figure.className = "source-thumb";
    figure.innerHTML = `<img src="${url}" alt="取説写真 ${index + 1}"><figcaption>${index + 1}</figcaption>`;
    sourcePreviewList.append(figure);
  });
}

function renderSourceFiles() {
  if (!sourceFileList) return;
  sourceFileList.innerHTML = "";
  sourceFilePayloads.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "source-file-item";
    const kind = file.kind === "pdf" ? "PDF" : "DATA";
    item.innerHTML = `<strong>${kind}</strong><span>${escapeHtml(file.name || `ファイル ${index + 1}`)}</span>`;
    sourceFileList.append(item);
  });
}

function updateSourceReadiness(resetMessage = false) {
  const total = sourcePhotoPayloads.length + sourceFilePayloads.length;
  readManualPhoto.disabled = total === 0;
  clearManualPhoto.disabled = total === 0;
  if (resetMessage) {
    ocrStatus.textContent = "写真・PDF・テキストを選べます。原本はSupabaseへ保存し、読み取った要点もフォームへ転記します。";
    return;
  }
  if (total > 0) {
    ocrStatus.textContent = `写真${sourcePhotoPayloads.length}枚、ファイル${sourceFilePayloads.length}件を確認しました。まとめて読み取れます。`;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", reject);
    reader.readAsText(file);
  });
}

async function fileToSourcePayload(file) {
  const name = file.name || "source";
  const isPdf = file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    return {
      kind: "pdf",
      name,
      type: file.type || "application/pdf",
      dataUrl: await fileToDataUrl(file)
    };
  }
  return {
    kind: "text",
    name,
    type: file.type || "text/plain",
    text: await fileToText(file)
  };
}

function applyOcrResult(data) {
  const fields = manualForm.elements;
  if (data.title && !fields.title.value.trim()) fields.title.value = data.title;
  if (data.room && !fields.room.value.trim()) fields.room.value = data.room;
  if (data.category && !fields.category.value.trim()) fields.category.value = data.category;
  if (Array.isArray(data.tags)) fields.tags.value = mergeTextList(fields.tags.value, data.tags, "、");
  if (Array.isArray(data.symptoms)) fields.symptoms.value = mergeTextList(fields.symptoms.value, data.symptoms, "\n");
  if (Array.isArray(data.steps)) fields.steps.value = mergeTextList(fields.steps.value, data.steps, "\n");
  if (Array.isArray(data.maintenanceTasks)) {
    pendingMaintenanceTasks = normalizeMaintenanceTasks(data.maintenanceTasks);
  }
  if (Array.isArray(data.storedSources) && data.storedSources.length) {
    pendingSources = mergeSources(pendingSources, data.storedSources);
  }
  if (data.sourceText) {
    pendingSourceText = [pendingSourceText.trim(), String(data.sourceText).trim()].filter(Boolean).join("\n\n");
  }
  const memoParts = [
    data.modelNumber ? `品番: ${data.modelNumber}` : "",
    data.content || "",
    data.contact ? `問い合わせ先: ${data.contact}` : "",
    data.cautions ? `注意点: ${data.cautions}` : ""
  ].filter(Boolean);
  if (memoParts.length) {
    fields.content.value = [fields.content.value.trim(), memoParts.join("\n")].filter(Boolean).join("\n\n");
  }
}

function pendingSourceTextFromForm(content) {
  const existing = manualForm.elements.id.value
    ? state.manuals.find((manual) => manual.id === manualForm.elements.id.value)?.sourceText || ""
    : "";
  return [existing.trim(), pendingSourceText.trim(), String(content || "").trim()]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("\n\n");
}

function mergeSources(existing, additions) {
  const byPath = new Map((existing || []).map((source) => [source.storagePath || source.id, normalizeSource(source)]));
  additions.forEach((source) => {
    const normalized = normalizeSource(source);
    byPath.set(normalized.storagePath || normalized.id, normalized);
  });
  return [...byPath.values()];
}

function mergeTextList(current, additions, separator) {
  const existing = splitLinesOrComma(current);
  const merged = [...existing];
  additions.map(String).map((item) => item.trim()).filter(Boolean).forEach((item) => {
    if (!merged.includes(item)) merged.push(item);
  });
  return merged.join(separator);
}

async function initializeAuth() {
  const loginScreen = document.querySelector("#loginScreen");
  const loginForm = document.querySelector("#loginForm");
  const loginStatus = document.querySelector("#loginStatus");
  try {
    const response = await fetch("/api/auth/status");
    if (!response.ok) throw new Error(await response.text());
    authStatus = await response.json();
    if (authStatus.required && !authStatus.authenticated) {
      loginScreen.hidden = false;
      document.body.classList.add("auth-locked");
    } else {
      loginScreen.hidden = true;
      document.body.classList.remove("auth-locked");
    }
  } catch {
    authStatus = { required: false, authenticated: true };
    loginScreen.hidden = true;
    document.body.classList.remove("auth-locked");
  }

  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginStatus.textContent = "確認しています。";
    const password = new FormData(event.currentTarget).get("password");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!response.ok) throw new Error(await response.text());
      loginScreen.hidden = true;
      document.body.classList.remove("auth-locked");
      loginStatus.textContent = "";
      await renderAiSettings();
      scheduleAutoPull();
    } catch {
      loginStatus.textContent = "パスワードが違います。";
    }
  });
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    notificationStatus.textContent = "通知: このブラウザでは使えません";
    return;
  }
  const permission = await Notification.requestPermission();
  renderNotificationStatus();
  if (permission === "granted") {
    notifyDueTasks(true);
  }
}

function renderNotificationStatus() {
  if (!("Notification" in window)) {
    notificationStatus.textContent = "通知: 非対応";
    return;
  }
  notificationStatus.textContent = {
    granted: "通知: 有効",
    denied: "通知: ブロック中",
    default: "通知: 未許可"
  }[Notification.permission] || "通知: 未確認";
}

function loadNotifiedTaskKeys() {
  try {
    return new Set(JSON.parse(localStorage.getItem("home-care-notified-tasks-v1") || "[]"));
  } catch {
    return new Set();
  }
}

function scheduleReminders() {
  clearTimeout(reminderTimer);
  renderNotificationStatus();
  notifyDueTasks(false);
  reminderTimer = setTimeout(scheduleReminders, 60 * 60 * 1000);
}

function notifyDueTasks(force) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const todayKey = toDateKey(new Date());
  const dueTasks = state.tasks.filter((task) => task.entryType !== "event" && task.nextDate <= todayKey);
  dueTasks.forEach((task) => {
    const notifyKey = `${todayKey}:${task.id}`;
    if (!force && notifiedTaskKeys.has(notifyKey)) return;
    const overdue = task.nextDate < todayKey;
    new Notification(overdue ? "期限切れの家メンテがあります" : "今日の家メンテ予定", {
      body: `${task.title} / ${task.area} / ${formatShortDate(task.nextDate)}`,
      tag: `home-care-${task.id}`
    });
    notifiedTaskKeys.add(notifyKey);
  });
  localStorage.setItem("home-care-notified-tasks-v1", JSON.stringify([...notifiedTaskKeys].slice(-100)));
}

function tokenize(value) {
  const compact = value.toLowerCase().replace(/\s+/g, "");
  const words = value.toLowerCase().split(/[\s,、。・]+/).filter(Boolean);
  const grams = [];
  for (let i = 0; i < compact.length - 1; i += 1) {
    grams.push(compact.slice(i, i + 2));
  }
  return [...new Set([...words, ...grams])];
}

function isOverdue(task) {
  return parseLocalDate(task.nextDate) < startOfDay(new Date());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseLocalDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShortDate(dateKey) {
  const date = parseLocalDate(dateKey);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(date);
}

function frequencyLabel(value) {
  return {
    none: "1回のみ",
    weekly: "毎週",
    monthly: "毎月",
    quarterly: "3か月ごと",
    yearly: "毎年"
  }[value] || value;
}

function formatAnswer(answer) {
  return escapeHtml(answer)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
