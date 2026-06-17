const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const dataDir = process.env.DATA_DIR || root;
const dataFile = process.env.DATA_FILE || path.join(dataDir, "shared-data.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const aiModel = process.env.OPENAI_MODEL || "gpt-5-mini";
const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseTable = process.env.SUPABASE_TABLE || "home_care_shared_data";
const supabaseBucket = process.env.SUPABASE_BUCKET || "home-care-sources";
const appPassword = process.env.APP_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8"
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 55_000_000) {
        reject(new Error("Request too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function readStore() {
  if (!fs.existsSync(dataFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
}

function send(response, status, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(payload);
}

function sendJson(response, status, payload) {
  send(response, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }));
}

function signSession(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function isAuthenticated(request) {
  if (!appPassword) return true;
  const session = parseCookies(request).home_care_session || "";
  const [value, signature] = session.split(".");
  if (!value || !signature) return false;
  const expected = signSession(value);
  return signature.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function setSessionCookie(response) {
  const value = crypto.randomBytes(24).toString("hex");
  const cookie = `${value}.${signSession(value)}`;
  response.setHeader("Set-Cookie", `home_care_session=${encodeURIComponent(cookie)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
}

async function handleAuth(request, response, url) {
  if (url.pathname === "/api/auth/status") {
    sendJson(response, 200, {
      required: Boolean(appPassword),
      authenticated: isAuthenticated(request)
    });
    return true;
  }

  if (url.pathname === "/api/auth/login") {
    if (request.method !== "POST") {
      send(response, 405, "Method not allowed.");
      return true;
    }
    const body = JSON.parse(await readBody(request) || "{}");
    const password = String(body.password || "");
    const ok = Boolean(appPassword) && crypto.timingSafeEqual(
      Buffer.from(crypto.createHash("sha256").update(password).digest("hex")),
      Buffer.from(crypto.createHash("sha256").update(appPassword).digest("hex"))
    );
    if (!ok) {
      send(response, 401, "Invalid password.");
      return true;
    }
    setSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

function familyHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sharedRecordFrom(data) {
  return {
    manuals: Array.isArray(data.manuals) ? data.manuals : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    updatedAt: data.updatedAt || new Date().toISOString()
  };
}

function hasSupabaseStore() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey);
}

function supabaseHeaders(contentType = "application/json") {
  const authHeaders = supabaseServiceRoleKey.startsWith("sb_secret_")
    ? {}
    : { Authorization: `Bearer ${supabaseServiceRoleKey}` };
  return {
    apikey: supabaseServiceRoleKey,
    ...authHeaders,
    ...(contentType ? { "Content-Type": contentType } : {})
  };
}

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      ...supabaseHeaders(),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Supabase error ${response.status}: ${message.slice(0, 180)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function readSharedData(key) {
  if (!hasSupabaseStore()) {
    return readStore()[key] || null;
  }

  const rows = await supabaseRequest(
    `${encodeURIComponent(supabaseTable)}?family_hash=eq.${encodeURIComponent(key)}&select=data,updated_at&limit=1`
  );
  if (!Array.isArray(rows) || !rows.length) return null;
  return {
    ...sharedRecordFrom(rows[0].data || {}),
    updatedAt: rows[0].updated_at || rows[0].data?.updatedAt || ""
  };
}

async function writeSharedData(key, data) {
  const record = sharedRecordFrom(data);
  if (!hasSupabaseStore()) {
    const store = readStore();
    store[key] = record;
    writeStore(store);
    return record;
  }

  await supabaseRequest(encodeURIComponent(supabaseTable), {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      family_hash: key,
      data: record,
      updated_at: record.updatedAt
    })
  });
  return record;
}

async function handleApi(request, response, url) {
  if (request.method === "OPTIONS") {
    send(response, 204, "");
    return;
  }

  const family = url.searchParams.get("family");
  if (!family || family.length < 4) {
    send(response, 400, "Family code is required.");
    return;
  }

  const key = familyHash(family);

  if (request.method === "GET") {
    const shared = await readSharedData(key);
    if (!shared) {
      send(response, 404, "No shared data.");
      return;
    }
    sendJson(response, 200, shared);
    return;
  }

  if (request.method === "PUT") {
    const body = await readBody(request);
    const data = JSON.parse(body || "{}");
    const record = await writeSharedData(key, data);
    sendJson(response, 200, { ok: true, updatedAt: record.updatedAt, storage: hasSupabaseStore() ? "supabase" : "file" });
    return;
  }

  send(response, 405, "Method not allowed.");
}

function aiResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: {
        type: "string",
        description: "ユーザーに表示する日本語回答。資料に書かれていることだけで、結論、確認すること、手順、注意点を含める。"
      },
      sources: {
        type: "array",
        description: "回答根拠に使った資料名。根拠がなければ空配列。",
        items: { type: "string" }
      },
      diagram: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            description: "図解のタイトル。図解不要なら空文字。"
          },
          nodes: {
            type: "array",
            description: "確認や作業の流れ。図解不要なら空配列。",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: {
                  type: "string",
                  description: "短い見出し。"
                },
                detail: {
                  type: "string",
                  description: "補足説明。"
                },
                kind: {
                  type: "string",
                  enum: ["start", "check", "action", "warning", "contact"]
                }
              },
              required: ["label", "detail", "kind"]
            }
          }
        },
        required: ["title", "nodes"]
      }
    },
    required: ["answer", "sources", "diagram"]
  };
}

function ocrResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", description: "設備名。読み取れなければ空文字。" },
      room: { type: "string", description: "設置場所。読み取れなければ空文字。" },
      category: { type: "string", description: "分類。空調、水回り、電気など。推測しすぎず短く。" },
      modelNumber: { type: "string", description: "品番や型番。読み取れなければ空文字。" },
      tags: { type: "array", items: { type: "string" }, description: "検索しやすいタグ。" },
      symptoms: { type: "array", items: { type: "string" }, description: "よくある症状やエラー。" },
      steps: { type: "array", items: { type: "string" }, description: "取説に書かれた操作や確認手順。" },
      maintenanceTasks: {
        type: "array",
        description: "取説から読み取れる定期メンテナンス、清掃、交換、点検の予定候補。",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "カレンダーに入れる短いタスク名。" },
            area: { type: "string", description: "場所。分からなければ空文字。" },
            kind: { type: "string", enum: ["掃除", "点検", "交換", "連絡"], description: "予定の種類。" },
            frequency: { type: "string", enum: ["none", "weekly", "monthly", "quarterly", "yearly"], description: "周期。" },
            nextDate: { type: "string", description: "YYYY-MM-DD。具体日がなければ空文字。" },
            note: { type: "string", description: "根拠になる取説の記載や補足。" }
          },
          required: ["title", "area", "kind", "frequency", "nextDate", "note"]
        }
      },
      content: { type: "string", description: "保存しておくべき要点のメモ。" },
      sourceText: { type: "string", description: "写真やPDFから読めた文字、表、警告、手順をできるだけ原文に近くまとめた本文。" },
      contact: { type: "string", description: "問い合わせ先。読み取れなければ空文字。" },
      cautions: { type: "string", description: "安全上の注意。読み取れなければ空文字。" }
    },
    required: ["title", "room", "category", "modelNumber", "tags", "symptoms", "steps", "maintenanceTasks", "content", "sourceText", "contact", "cautions"]
  };
}

function parseOpenAiPayload(data) {
  const text = data.output_text || (data.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("\n")
    .trim();
  if (!text) throw new Error("AI response was empty.");
  return JSON.parse(text);
}

function safeSourceFileName(value) {
  return String(value || "source")
    .replace(/[^\w.\-ぁ-んァ-ン一-龠々ー ]/g, "_")
    .slice(0, 120);
}

function sourceFileParts(files) {
  return files.flatMap((file) => {
    const kind = String(file.kind || "");
    const name = safeSourceFileName(file.name);
    const text = String(file.text || "").trim();
    const dataUrl = String(file.dataUrl || "");
    if (kind === "pdf" && dataUrl.startsWith("data:application/pdf")) {
      return [{
        type: "input_file",
        filename: name.endsWith(".pdf") ? name : `${name}.pdf`,
        file_data: dataUrl
      }];
    }
    if (text) {
      return [{
        type: "input_text",
        text: `\n\n--- 添付データ: ${name} ---\n${text.slice(0, 45_000)}`
      }];
    }
    return [];
  });
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

async function ensureStorageBucket() {
  if (!hasSupabaseStore()) return false;
  const response = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ id: supabaseBucket, name: supabaseBucket, public: false })
  });
  if (response.ok || response.status === 409 || response.status === 400) return true;
  throw new Error(`Supabase storage bucket error ${response.status}: ${(await response.text()).slice(0, 160)}`);
}

async function uploadSourceFiles(family, imageFiles, files) {
  if (!family || !hasSupabaseStore()) return [];
  await ensureStorageBucket();
  const familyKey = familyHash(family);
  const items = [
    ...imageFiles.map((file, index) => ({
      kind: "image",
      name: safeSourceFileName(file.name || `photo-${index + 1}.jpg`),
      dataUrl: file.dataUrl,
      fallbackMime: file.type || "image/jpeg"
    })),
    ...files.filter((file) => String(file.kind || "") === "pdf").map((file, index) => ({
      kind: "pdf",
      name: safeSourceFileName(file.name || `source-${index + 1}.pdf`),
      dataUrl: file.dataUrl,
      fallbackMime: "application/pdf"
    }))
  ];

  const uploaded = [];
  for (const item of items) {
    const parsed = parseDataUrl(item.dataUrl);
    if (!parsed) continue;
    const extension = path.extname(item.name) || (parsed.mimeType === "application/pdf" ? ".pdf" : ".jpg");
    const objectPath = `${familyKey}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension}`;
    const response = await fetch(`${supabaseUrl}/storage/v1/object/${supabaseBucket}/${objectPath}`, {
      method: "POST",
      headers: {
        ...supabaseHeaders(parsed.mimeType || item.fallbackMime),
        "x-upsert": "true"
      },
      body: parsed.buffer
    });
    if (!response.ok) {
      throw new Error(`Supabase storage upload error ${response.status}: ${(await response.text()).slice(0, 160)}`);
    }
    uploaded.push({
      id: crypto.randomUUID(),
      type: item.kind,
      name: item.name,
      storagePath: objectPath,
      mimeType: parsed.mimeType || item.fallbackMime,
      bucket: supabaseBucket,
      createdAt: new Date().toISOString()
    });
  }
  return uploaded;
}

async function handleAiAnswer(request, response) {
  if (request.method === "OPTIONS") {
    send(response, 204, "");
    return;
  }

  if (request.method !== "POST") {
    send(response, 405, "Method not allowed.");
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    send(response, 503, "OpenAI API key is not configured.");
    return;
  }

  const body = JSON.parse(await readBody(request) || "{}");
  const query = String(body.query || "").trim();
  const sourceText = String(body.sourceText || "").trim();
  if (!query || !sourceText) {
    send(response, 400, "Query and source text are required.");
    return;
  }

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: aiModel,
      instructions: [
        "あなたは家庭設備の取扱説明書を読むアシスタントです。",
        "NotebookLMのように、必ずユーザーが登録した資料だけを根拠に回答してください。",
        "資料にない情報、一般知識、推測、補完、経験則を回答に混ぜないでください。",
        "資料だけで答えられない場合は、答えを作らず「登録済み資料からは判断できません」と書いてください。",
        "回答内に、根拠に使った資料名を必ず含めてください。",
        "危険、ガス、電気、水漏れ、焦げ臭い、異音、発熱に関わる場合は、使用停止や専門業者への相談を優先してください。",
        "日本語で、結論、確認すること、手順、根拠資料、注意点の順に短く整理してください。",
        "配線、フィルター、弁、リモコン操作、確認順序など、文章だけでは迷いやすい場合は図解も付けてください。",
        "図解は登録済み資料から分かる範囲だけで作り、不明な部品配置や形状を想像で描かないでください。"
      ].join("\n"),
      input: `困りごと: ${query}\n\n登録済み資料:\n${sourceText}`,
      text: {
        format: {
          type: "json_schema",
          name: "home_care_answer",
          strict: true,
          schema: aiResponseSchema()
        },
        verbosity: "low"
      }
    })
  });

  if (!aiResponse.ok) {
    send(response, aiResponse.status, await aiResponse.text());
    return;
  }

  sendJson(response, 200, parseOpenAiPayload(await aiResponse.json()));
}

async function handleOcrManual(request, response) {
  if (request.method === "OPTIONS") {
    send(response, 204, "");
    return;
  }

  if (request.method !== "POST") {
    send(response, 405, "Method not allowed.");
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    send(response, 503, "OpenAI API key is not configured.");
    return;
  }

  const body = JSON.parse(await readBody(request) || "{}");
  const imageFiles = Array.isArray(body.imageFiles)
    ? body.imageFiles.map((file, index) => ({
      name: safeSourceFileName(file.name || `photo-${index + 1}.jpg`),
      type: String(file.type || "image/jpeg"),
      dataUrl: String(file.dataUrl || "")
    })).filter((file) => file.dataUrl.startsWith("data:image/")).slice(0, 12)
    : [];
  const imageDataUrls = imageFiles.length
    ? imageFiles.map((file) => file.dataUrl)
    : Array.isArray(body.imageDataUrls)
    ? body.imageDataUrls.map(String).filter((value) => value.startsWith("data:image/")).slice(0, 12)
    : [String(body.imageDataUrl || "")].filter((value) => value.startsWith("data:image/"));
  const files = Array.isArray(body.sourceFiles) ? body.sourceFiles.slice(0, 8) : [];
  const fileParts = sourceFileParts(files);
  if (!imageDataUrls.length && !fileParts.length) {
    send(response, 400, "Source photos or files are required.");
    return;
  }

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: aiModel,
      instructions: [
        "あなたは家庭設備の取扱説明書、ラベル、保証書、PDF、メモ、CSV/JSONデータから、家の管理アプリに保存する情報を抽出するアシスタントです。",
        "添付ソースに読める内容だけを使い、読めない項目は空文字または空配列にしてください。",
        "場所、分類、タグはソースから判断できる範囲で自動分類してください。判断材料が弱い場合は一般的すぎる分類にしてください。",
        "複数ページがある場合は、ページ間の重複を整理し、品番、エラー番号、警告、手順を取りこぼさないでください。",
        "定期メンテナンス、清掃、交換、点検の周期が読める場合は maintenanceTasks に入れてください。",
        `今日の日付は ${new Date().toISOString().slice(0, 10)} です。次回日が取説から分からない場合は nextDate を空文字にしてください。`,
        "読みにくい文字は推測せず、contentに「判読不明」と明記してください。",
        "ユーザーが後から検索しやすいよう、症状、エラー番号、掃除、交換、点検、問い合わせ先を優先して抜き出してください。",
        "危険や注意書きが読める場合は必ず cautions に要約してください。",
        "日本語で短く整理してください。"
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `写真${imageDataUrls.length}枚、ファイル${fileParts.length}件から家の管理アプリに保存するソースデータを抽出してください。` },
            ...imageDataUrls.map((image_url) => ({ type: "input_image", image_url })),
            ...fileParts
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "manual_photo_extract",
          strict: true,
          schema: ocrResponseSchema()
        },
        verbosity: "low"
      }
    })
  });

  if (!aiResponse.ok) {
    send(response, aiResponse.status, await aiResponse.text());
    return;
  }

  const payload = parseOpenAiPayload(await aiResponse.json());
  let storedSources = [];
  let storageError = "";
  try {
    storedSources = await uploadSourceFiles(String(body.familyCode || ""), imageFiles, files);
  } catch (error) {
    storageError = error.message || "Storage upload failed.";
  }
  sendJson(response, 200, {
    ...payload,
    storedSources,
    storageEnabled: hasSupabaseStore(),
    storageSaved: storedSources.length,
    storageError
  });
}

function handleStatus(response) {
  sendJson(response, 200, {
    ok: true,
    aiEnabled: Boolean(process.env.OPENAI_API_KEY),
    aiModel,
    sharedStorage: hasSupabaseStore() ? "supabase" : "file",
    sourceStorage: hasSupabaseStore() ? "supabase-storage" : "none",
    sourceBucket: supabaseBucket,
    authRequired: Boolean(appPassword)
  });
}

function handleStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.join(root, requestedPath);
  if (!file.startsWith(root)) {
    send(response, 403, "Forbidden.");
    return;
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      send(response, 404, "Not found.");
      return;
    }
    send(response, 200, data, types[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (await handleAuth(request, response, url)) {
      return;
    }
    if (url.pathname === "/api/status") {
      handleStatus(response);
      return;
    }
    if (url.pathname.startsWith("/api/") && !isAuthenticated(request)) {
      send(response, 401, "Authentication required.");
      return;
    }
    if (url.pathname === "/api/shared-data") {
      await handleApi(request, response, url);
      return;
    }
    if (url.pathname === "/api/ai-answer") {
      await handleAiAnswer(request, response);
      return;
    }
    if (url.pathname === "/api/ocr-manual") {
      await handleOcrManual(request, response);
      return;
    }
    handleStatic(request, response, url);
  } catch (error) {
    send(response, 500, error.message || "Server error.");
  }
});

server.on("error", (error) => {
  console.error(`家の管理アプリを起動できませんでした: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`家の管理アプリ: http://${host}:${port}`);
});
