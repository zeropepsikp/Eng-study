// POST /api/tutor/image — Hugging Face 텍스트→이미지 (튜터 초상 1회성 생성)
// Body: { prompt: string, model?: string }  →  { image: "data:image/...;base64,..." }
// 키는 환경변수 HUG_FACE_API_KEY. 실패 시 { error, status, detail } JSON 으로 사유를 함께 반환.

const DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell"; // Apache-2.0, 게이트 없음 → 서버리스에서 안정적
const FALLBACK_MODEL = "stabilityai/stable-diffusion-xl-base-1.0";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

async function tryFetch(endpoint, key, prompt) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "image/png" },
    body: JSON.stringify({ inputs: prompt })
  });
}

async function generate(model, key, prompt) {
  // 신(라우터) → 구(api-inference) 순으로 시도
  const endpoints = [
    "https://router.huggingface.co/hf-inference/models/" + model,
    "https://api-inference.huggingface.co/models/" + model
  ];
  let lastStatus = 0, lastDetail = "";
  for (const ep of endpoints) {
    let r;
    try { r = await tryFetch(ep, key, prompt); }
    catch (e) { lastDetail = "fetch failed"; continue; }
    const ctype = (r.headers.get("content-type") || "");
    if (r.ok && ctype.indexOf("image") === 0) {
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return { ok: true, image: "data:" + ctype + ";base64," + btoa(bin) };
    }
    lastStatus = r.status;
    try { lastDetail = (await r.text()).slice(0, 300); } catch (e) { lastDetail = ""; }
  }
  return { ok: false, status: lastStatus, detail: lastDetail };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.HUG_FACE_API_KEY;
    if (!key) return json({ error: "HUG_FACE_API_KEY not configured" }, 500);

    let data;
    try { data = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const prompt = (data && typeof data.prompt === "string" && data.prompt.trim()) ? data.prompt.trim() : "";
    if (!prompt) return json({ error: "missing prompt" }, 400);
    const model = (data && typeof data.model === "string" && data.model.trim()) ? data.model.trim() : DEFAULT_MODEL;

    let res = await generate(model, key, prompt);
    if (!res.ok && model !== FALLBACK_MODEL) {
      const alt = await generate(FALLBACK_MODEL, key, prompt);
      if (alt.ok) res = alt; else res.detail = (res.detail || "") + " | fallback(" + FALLBACK_MODEL + "): " + (alt.detail || alt.status);
    }
    if (res.ok) return json({ image: res.image }, 200);

    const loading = res.status === 503;
    return json({ error: "image generation failed", status: res.status, detail: res.detail, model: model, loading: loading }, loading ? 503 : 502);
  } catch (e) {
    return json({ error: "server error", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
