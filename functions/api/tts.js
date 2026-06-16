// Cloudflare Pages Function — POST /api/tts
// 브라우저가 {text, voice}를 보내면 Google Cloud TTS로 mp3를 만들어 돌려준다.
// Google API 키는 Cloudflare 환경변수(GOOGLE_TTS_KEY)에만 있고 클라이언트엔 노출되지 않는다.
// 같은 (voice+text)는 엣지 캐시에 저장해 호출/비용을 줄인다.

const ALLOWED_VOICES = new Set([
  "en-US-Neural2-F", "en-US-Neural2-C", "en-US-Neural2-G",
  "en-US-Neural2-D", "en-US-Neural2-A",
  "en-US-Chirp3-HD-Aoede", "en-US-Chirp3-HD-Charon"
]);
const DEFAULT_VOICE = "en-US-Neural2-F";
const MAX_LEN = 400; // 한 문장 학습용 — 과도한 텍스트 차단

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.GOOGLE_TTS_KEY;
    if (!key) return new Response("TTS key not configured", { status: 500 });

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    let text = (data && typeof data.text === "string") ? data.text.trim() : "";
    let voice = (data && typeof data.voice === "string") ? data.voice : DEFAULT_VOICE;
    if (!text) return new Response("missing text", { status: 400 });
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);
    if (!ALLOWED_VOICES.has(voice)) voice = DEFAULT_VOICE;

    // 엣지 캐시 조회 (voice+text를 키로)
    const cache = caches.default;
    const cacheKey = new Request(
      new URL("https://tts-cache.local/" + encodeURIComponent(voice) + "/" + encodeURIComponent(text)),
      { method: "GET" }
    );
    let hit = await cache.match(cacheKey);
    if (hit) return hit;

    const body = {
      input: { text },
      voice: { languageCode: "en-US", name: voice },
      audioConfig: { audioEncoding: "MP3", speakingRate: 0.96 }
    };
    const g = await fetch(
      "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + encodeURIComponent(key),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!g.ok) return new Response("tts upstream " + g.status, { status: 502 });
    const j = await g.json();
    if (!j || !j.audioContent) return new Response("no audio", { status: 502 });

    // base64 -> bytes
    const bin = atob(j.audioContent);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const resp = new Response(bytes, {
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

// GET 등은 사용 안 함
export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
