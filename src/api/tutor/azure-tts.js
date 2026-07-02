// POST /api/tutor/azure-tts — Azure AI Speech (Neural TTS). Body: { text, voice }
// env.AZURE_KEY = Speech 리소스 키 (F0 무료 티어). 리전은 리소스를 만든 Korea Central 고정
// (env.AZURE_REGION 있으면 그것으로 override).
// 실패/한도초과 시 비-200 → 클라가 폰 기본 음성으로 폴백.

const REGION = "koreacentral";
const MAX_LEN = 700;
const DEFAULT_VOICE = "en-US-AndrewNeural";

// 짧은 이름 -> SSML용 성별. 목록은 클라이언트(index.html)의 AZURE_VOICES와 반드시 일치시킬 것.
const VOICE_GENDER = {
  "en-US-AndrewNeural": "Male", "en-US-BrianNeural": "Male", "en-US-GuyNeural": "Male",
  "en-US-DavisNeural": "Male", "en-US-ChristopherNeural": "Male", "en-US-EricNeural": "Male",
  "en-US-JasonNeural": "Male", "en-US-TonyNeural": "Male", "en-US-RogerNeural": "Male",
  "en-US-SteffanNeural": "Male", "en-US-BrandonNeural": "Male", "en-US-JacobNeural": "Male",
  "en-US-EmmaNeural": "Female", "en-US-AvaNeural": "Female", "en-US-AriaNeural": "Female",
  "en-US-JennyNeural": "Female", "en-US-MichelleNeural": "Female", "en-US-NancyNeural": "Female",
  "en-US-SaraNeural": "Female", "en-US-JaneNeural": "Female", "en-US-CoraNeural": "Female",
  "en-US-ElizabethNeural": "Female", "en-US-MonicaNeural": "Female",
  "en-GB-RyanNeural": "Male", "en-GB-AlfieNeural": "Male", "en-GB-ElliotNeural": "Male",
  "en-GB-EthanNeural": "Male", "en-GB-NoahNeural": "Male", "en-GB-OliverNeural": "Male",
  "en-GB-ThomasNeural": "Male",
  "en-GB-SoniaNeural": "Female", "en-GB-LibbyNeural": "Female", "en-GB-AbbiNeural": "Female",
  "en-GB-BellaNeural": "Female", "en-GB-HollieNeural": "Female", "en-GB-OliviaNeural": "Female",
  "en-AU-WilliamNeural": "Male", "en-AU-NatashaNeural": "Female",
  "en-IE-ConnorNeural": "Male", "en-IE-EmilyNeural": "Female"
};

function jsonErr(error, status, detail) {
  return new Response(JSON.stringify({ error, status, detail }), {
    status: status === 429 ? 429 : 502, headers: { "Content-Type": "application/json" }
  });
}
function xmlEsc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function localeOf(name) {
  var m = /^([a-z]{2}-[A-Z]{2})-/.exec(name || "");
  return m ? m[1] : "en-US";
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.AZURE_KEY;
    if (!key) return jsonErr("Azure key not configured", 500, "");

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    let text = (data && typeof data.text === "string") ? data.text.trim() : "";
    if (!text) return new Response("missing text", { status: 400 });
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);

    let voice = (data && typeof data.voice === "string") ? data.voice : "";
    if (voice.indexOf("azure:") === 0) voice = voice.slice(6);
    if (!VOICE_GENDER[voice]) voice = DEFAULT_VOICE;
    const gender = VOICE_GENDER[voice];
    const locale = localeOf(voice);

    // 엣지 캐시 (voice+text)
    let cache = null, cacheKey = null;
    try {
      cache = caches.default;
      cacheKey = new Request("https://azure-tts.local/" + encodeURIComponent(voice) + "/" + encodeURIComponent(text), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) { cache = null; }

    const region = env.AZURE_REGION || REGION;
    const endpoint = "https://" + region + ".tts.speech.microsoft.com/cognitiveservices/v1";
    const ssml = "<speak version='1.0' xml:lang='" + locale + "'>" +
      "<voice xml:lang='" + locale + "' xml:gender='" + gender + "' name='" + voice + "'>" +
      xmlEsc(text) + "</voice></speak>";

    let r;
    try {
      r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "eng-study-app"
        },
        body: ssml
      });
    } catch (e) {
      return jsonErr("azure connect failed", 502, String(e && e.message || e));
    }
    if (!r.ok) {
      const msg = await r.text().catch(function () { return ""; });
      const quota = r.status === 429;
      return jsonErr("azure tts failed", quota ? 429 : 502, (r.status + " " + msg).slice(0, 200));
    }

    const buf = await r.arrayBuffer();
    const resp = new Response(buf, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
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
