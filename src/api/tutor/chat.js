// POST /api/tutor/chat — Gemini 2.5 Flash 대화 (JSON 출력)
// Body: { system: string, history: [{role:'user'|'model', text}], message: string }
// 키는 Cloudflare 환경변수 GEMINI_KEY 에만 둔다. 실패 시 비-200 → 클라가 폴백.

const MODEL = "gemini-2.5-flash";
const MAX_MSG = 1200;
const MAX_HISTORY = 24;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    correction: {
      type: "OBJECT",
      properties: {
        has_issues: { type: "BOOLEAN" },
        fixed: { type: "STRING" },
        why_ko: { type: "STRING" }
      },
      required: ["has_issues", "fixed", "why_ko"]
    },
    reply_en: { type: "STRING" },
    reply_ko: { type: "STRING" },
    hint_ko: { type: "STRING" }
  },
  required: ["correction", "reply_en", "reply_ko", "hint_ko"]
};

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.GEMINI_KEY;
    if (!key) return new Response("GEMINI_KEY not configured", { status: 500 });

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    const system = (data && typeof data.system === "string") ? data.system : "";
    let message = (data && typeof data.message === "string") ? data.message.trim() : "";
    if (message.length > MAX_MSG) message = message.slice(0, MAX_MSG);
    let history = Array.isArray(data && data.history) ? data.history : [];
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

    const contents = [];
    for (const h of history) {
      if (!h || !h.text) continue;
      const role = (h.role === "model") ? "model" : "user";
      contents.push({ role, parts: [{ text: String(h.text).slice(0, MAX_MSG) }] });
    }
    if (message) contents.push({ role: "user", parts: [{ text: message }] });
    if (!contents.length) return new Response("empty", { status: 400 });

    const body = {
      contents,
      generationConfig: {
        temperature: 0.9,
        responseMimeType: "application/json",
        responseSchema: SCHEMA
      }
    };
    if (system) body.system_instruction = { parts: [{ text: system }] };

    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + encodeURIComponent(key);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) return new Response("gemini " + r.status, { status: 502 });
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!txt) return new Response("no content", { status: 502 });

    // txt 는 이미 JSON 문자열(responseSchema 강제). 그대로 전달.
    return new Response(txt, { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response("error", { status: 500 });
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
