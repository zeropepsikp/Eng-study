// Cloudflare Pages Function — POST /api/tts
// 브라우저가 {text, voice}를 보내면 OpenAI TTS로 mp3를 만들어 돌려준다.
// OpenAI API 키는 Cloudflare 환경변수(OPENAI_TTS_KEY)에만 있고 클라이언트엔 노출되지 않는다.
// 같은 (voice+text)는 엣지 캐시에 저장해 호출/비용을 줄인다.
// 키가 없거나 크레딧 부족(429) 등으로 실패하면 502를 반환 → 클라이언트가 폰 기본 음성으로 폴백.

const MODEL = "gpt-4o-mini-tts"; // 저렴 + 자연스러움. (대안: "tts-1"=단순/저렴, "tts-1-hd"=고품질/비쌈)
const ALLOWED_VOICES = new Set([
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"
]);
const DEFAULT_VOICE = "alloy";
const MAX_LEN = 400; // 한 문장 학습용 — 과도한 텍스트 차단
const INSTRUCTIONS = "Speak clearly and naturally at a slightly slower, friendly pace, like an English teacher helping a learner.";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.OPENAI_TTS_KEY;
    if (!key) return new Response("TTS key not configured", { status: 500 });

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    let text = (data && typeof data.text === "string") ? data.text.trim() : "";
    let voice = (data && typeof data.voice === "string") ? data.voice : DEFAULT_VOICE;
    if (!text) return new Response("missing text", { status: 400 });
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);
    if (!ALLOWED_VOICES.has(voice)) voice = DEFAULT_VOICE;

    // 엣지 캐시 조회 (model+voice+text를 키로)
    const cache = caches.default;
    const cacheKey = new Request(
      new URL("https://tts-cache.local/" + encodeURIComponent(MODEL) + "/" + encodeURIComponent(voice) + "/" + encodeURIComponent(text)),
      { method: "GET" }
    );
    let hit = await cache.match(cacheKey);
    if (hit) return hit;

    const body = {
      model: MODEL,
      input: text,
      voice: voice,
      response_format: "mp3",
      instructions: INSTRUCTIONS
    };
    const g = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!g.ok) return new Response("tts upstream " + g.status, { status: 502 });

    // OpenAI는 오디오 바이트를 그대로 반환한다.
    const buf = await g.arrayBuffer();
    const resp = new Response(buf, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    });
    context.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response("error", { status: 500 });
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
