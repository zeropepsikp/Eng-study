// POST /api/tutor/image — Hugging Face 텍스트→이미지 (튜터 초상 1회성 생성)
// Body: { prompt: string, model?: string }  →  { image: "data:image/...;base64,..." }
// 키는 환경변수 HUG_FACE_API_KEY. 실패/로딩 시 비-200 → 클라가 플레이스홀더로 폴백.

const DEFAULT_MODEL = "black-forest-labs/FLUX.1-dev";
const NEGATIVE = "cartoon, anime, illustration, 3d render, deformed, extra fingers, watermark, text";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.HUG_FACE_API_KEY;
    if (!key) return new Response("HUG_FACE_API_KEY not configured", { status: 500 });

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    const prompt = (data && typeof data.prompt === "string" && data.prompt.trim()) ? data.prompt.trim() : "";
    if (!prompt) return new Response("missing prompt", { status: 400 });
    const model = (data && typeof data.model === "string" && data.model.trim()) ? data.model.trim() : DEFAULT_MODEL;

    const r = await fetch("https://api-inference.huggingface.co/models/" + model, {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "image/png" },
      body: JSON.stringify({ inputs: prompt, parameters: { negative_prompt: NEGATIVE }, options: { wait_for_model: true } })
    });
    if (!r.ok) {
      // 모델 로딩(503) 등 — 상태 그대로 전달해 클라가 재시도/폴백
      return new Response("hf " + r.status, { status: r.status === 503 ? 503 : 502 });
    }
    const ctype = r.headers.get("content-type") || "image/png";
    const buf = new Uint8Array(await r.arrayBuffer());
    // base64 인코딩
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const b64 = btoa(bin);
    return new Response(JSON.stringify({ image: "data:" + ctype + ";base64," + b64 }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response("error", { status: 500 });
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
