// POST /api/tutor/tts — Cloudflare Workers AI TTS (MeloTTS). Body: { text, voice? }
// Workers AI 무료 한도 내에서 동작. 실패/한도초과 시 비-200 → 클라가 기본(브라우저) 음성으로 폴백.
// voice 값은 호환을 위해 받기만 하고 무시한다(MeloTTS는 언어별 단일 음성).

const MODEL = "@cf/myshell-ai/melotts";
const MAX_LEN = 700;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function jsonErr(error, status, detail) {
  return new Response(JSON.stringify({ error, status, detail }), {
    status: status === 429 ? 429 : 502, headers: { "Content-Type": "application/json" }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.AI) return jsonErr("Workers AI binding (AI) not configured", 500, "");

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    let text = (data && typeof data.text === "string") ? data.text.trim() : "";
    if (!text) return new Response("missing text", { status: 400 });
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);

    // Aura 화자 지정: voice="aura:<speaker>" 또는 male/guy 등 → orion. 그 외 → MeloTTS.
    const voice = (data && typeof data.voice === "string") ? data.voice : "";
    let speaker = "";
    if (voice.indexOf("aura:") === 0) speaker = voice.slice(5).replace(/[^a-zA-Z]/g, "").toLowerCase();
    else if (/male|man|guy|orion|brian|matthew/i.test(voice)) speaker = "orion";

    // 엣지 캐시 (text + 음성 종류 기준)
    let cache = null, cacheKey = null;
    try {
      cache = caches.default;
      cacheKey = new Request("https://cf-tts.local/" + (speaker ? ("a-" + speaker + "/") : "f/") + encodeURIComponent(text), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) { cache = null; }

    let out = null;
    if (speaker) {
      // Deepgram Aura — 지정 화자. 모델 미지원/오류면 MeloTTS로 폴백.
      try { out = await env.AI.run("@cf/deepgram/aura-1", { text: text, speaker: speaker }); }
      catch (e) { out = null; }
    }
    if (!out) {
      try {
        out = await env.AI.run(MODEL, { prompt: text, lang: "en" });
      } catch (e) {
        const msg = String(e && e.message || e);
        const quota = /quota|limit|exceed|429|capacity/i.test(msg);
        return jsonErr("workers ai tts failed", quota ? 429 : 502, msg.slice(0, 200));
      }
    }
    // 스트림(ReadableStream)으로 오는 경우 그대로 전달
    if (out && typeof out.getReader === "function") {
      const resp0 = new Response(out, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
      if (cache && cacheKey && context.waitUntil) { try { context.waitUntil(cache.put(cacheKey, resp0.clone())); } catch (e) {} }
      return resp0;
    }

    // MeloTTS 응답: { audio: "<base64 mp3>" }
    let bytes = null, ctype = "audio/mpeg";
    if (out && typeof out.audio === "string") {
      bytes = b64ToBytes(out.audio);
    } else if (out instanceof ArrayBuffer) {
      bytes = new Uint8Array(out);
    } else if (out && out.body) {
      // Response 형태로 올 경우 그대로 전달
      const resp = new Response(out.body, { headers: { "Content-Type": ctype, "Cache-Control": "public, max-age=86400" } });
      if (cache && cacheKey && context.waitUntil) { try { context.waitUntil(cache.put(cacheKey, resp.clone())); } catch (e) {} }
      return resp;
    }
    if (!bytes) return jsonErr("no audio in response", 502, "");

    const resp = new Response(bytes, { headers: { "Content-Type": ctype, "Cache-Control": "public, max-age=86400" } });
    if (cache && cacheKey && context.waitUntil) { try { context.waitUntil(cache.put(cacheKey, resp.clone())); } catch (e) {} }
    return resp;
  } catch (e) {
    return jsonErr("server error", 500, String(e && e.message || e));
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
