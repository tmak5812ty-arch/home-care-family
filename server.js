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
      if (body.length > 8_000_000) {
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

async function supabaseRequest(pathname, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
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
        description: "ユーザーに表示する日本語回答。結論、確認すること、手順、根拠資料、注意点を含める。"
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
    required: ["answer", "diagram"]
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
      content: { type: "string", description: "保存しておくべき要点のメモ。" },
      contact: { type: "string", description: "問い合わせ先。読み取れなければ空文字。" },
      cautions: { type: "string", description: "安全上の注意。読み取れなければ空文字。" }
    },
    required: ["title", "room", "category", "modelNumber", "tags", "symptoms", "steps", "content", "contact", "cautions"]
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
        "必ずユーザーが登録した資料だけを根拠に回答してください。",
        "資料にない断定は避け、不明点は不明と書いてください。",
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
  const imageDataUrl = String(body.imageDataUrl || "");
  if (!imageDataUrl.startsWith("data:image/")) {
    send(response, 400, "Image data URL is required.");
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
        "あなたは家庭設備の取扱説明書、ラベル、保証書の写真から、家の管理アプリに保存する情報を抽出するアシスタントです。",
        "写真に読める内容だけを使い、読めない項目は空文字または空配列にしてください。",
        "ユーザーが後から検索しやすいよう、症状、エラー番号、掃除、交換、点検、問い合わせ先を優先して抜き出してください。",
        "危険や注意書きが読める場合は必ず cautions に要約してください。",
        "日本語で短く整理してください。"
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "この写真から家の管理アプリに保存する取説データを抽出してください。" },
            { type: "input_image", image_url: imageDataUrl }
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

  sendJson(response, 200, parseOpenAiPayload(await aiResponse.json()));
}

function handleStatus(response) {
  sendJson(response, 200, {
    ok: true,
    aiEnabled: Boolean(process.env.OPENAI_API_KEY),
    aiModel,
    sharedStorage: hasSupabaseStore() ? "supabase" : "file"
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
    if (url.pathname === "/api/status") {
      handleStatus(response);
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
