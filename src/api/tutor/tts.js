// POST /api/tutor/tts — Gemini 2.5 Flash TTS. Body: { text, voice }
// Gemini는 raw PCM(s16le)을 주므로 WAV 헤더를 씌워 audio/wav 로 반환한다.
// 키는 환경변수 GEMINI_KEY. 실패 시 비-200 → 클라가 브라우저 음성으로 폴백.

const MODEL = "gemini-2.5-flash-preview-tts";
const ALLOWED = new Set(["Leda", "Aoede", "Kore", "Zephyr", "Callirrhoe", "Autonoe", "Despina", "Erinome", "Laomedeia", "Achernar", "Sulafat", "Vindemiatrix", "Puck", "Charon", "Fenrir", "Orus", "Enceladus"]);
const DEFAULT_VOICE = "Leda";
const MAX_LEN = 700;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pcmToWav(pcm, sampleRate) {
  const numCh = 1, bits = 16;
  const blockAlign = numCh * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = new ArrayBuffer(44 + pcm.length);
  const dv = new DataView(buf);
  let p = 0;
  const s = (str) => { for (let i = 0; i < str.length; i++) dv.setUint8(p++, str.charCodeAt(i)); };
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };
  s("RIFF"); u32(36 + pcm.length); s("WAVE");
  s("fmt "); u32(16); u16(1); u16(numCh); u32(sampleRate); u32(byteRate); u16(blockAlign); u16(bits);
  s("data"); u32(pcm.length);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.GEMINI_KEY;
    if (!key) return new Response("GEMINI_KEY not configured", { status: 500 });

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    let text = (data && typeof data.text === "string") ? data.text.trim() : "";
    let voice = (data && typeof data.voice === "string") ? data.voice : DEFAULT_VOICE;
    if (!text) return new Response("missing text", { status: 400 });
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);
    if (!ALLOWED.has(voice)) voice = DEFAULT_VOICE;

    // 엣지 캐시 (model+voice+text) — 무료 한도(429) 부담을 줄이려고 같은 문장은 재사용
    let cache = null, cacheKey = null;
    try {
      cache = caches.default;
      cacheKey = new Request("https://tutor-tts.local/" + encodeURIComponent(MODEL) + "/" + encodeURIComponent(voice) + "/" + encodeURIComponent(text), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) { cache = null; }

    const body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    };
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + encodeURIComponent(key);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 300); } catch (e) {}
      return jsonErr("gemini tts failed", r.status, detail);
    }
    const j = await r.json();
    const part = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0];
    const inline = part && part.inlineData;
    if (!inline || !inline.data) return jsonErr("no audio in response", 502, "");

    let rate = 24000;
    const m = /rate=(\d+)/.exec(inline.mimeType || "");
    if (m) rate = parseInt(m[1], 10) || 24000;

    const pcm = b64ToBytes(inline.data);
    const wav = pcmToWav(pcm, rate);
    const resp = new Response(wav, { headers: { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=86400" } });
    if (cache && cacheKey && context.waitUntil) { try { context.waitUntil(cache.put(cacheKey, resp.clone())); } catch (e) {} }
    return resp;
  } catch (e) {
    return jsonErr("server error", 500, String(e && e.message || e));
  }
}

function jsonErr(error, status, detail) {
  return new Response(JSON.stringify({ error, status, detail }), { status: status === 429 ? 429 : 502, headers: { "Content-Type": "application/json" } });
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
