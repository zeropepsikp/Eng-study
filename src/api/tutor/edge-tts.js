// POST /api/tutor/edge-tts — Microsoft Edge(읽어주기) 무료 뉴럴 음성. Body: { text, voice }
// 비공식 Edge TTS 엔드포인트(WebSocket)를 Worker에서 호출해 mp3를 받아 반환.
// 실패 시 비-200 → 클라가 Cloudflare(MeloTTS) → 기본 음성 순으로 폴백.

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const GEC_VERSION = "1-130.0.2849.68";
const MAX_LEN = 700;
const DEFAULT_VOICE = "en-US-AriaNeural";
const ALLOWED = new Set([
  "en-US-AriaNeural", "en-US-JennyNeural", "en-US-MichelleNeural", "en-US-GuyNeural",
  "en-US-ChristopherNeural", "en-US-EricNeural", "en-GB-SoniaNeural", "en-GB-RyanNeural",
  "en-AU-NatashaNeural"
]);

function jsonErr(error, status, detail) {
  return new Response(JSON.stringify({ error, status, detail }), {
    status: status === 429 ? 429 : 502, headers: { "Content-Type": "application/json" }
  });
}
function xmlEsc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
async function secMsGec() {
  // Windows file-time(100ns) since 1601, 5분 단위로 내림 + 토큰을 SHA-256(대문자 hex).
  // 값이 2^53 을 초과하므로 BigInt 로 계산해야 정확하다.
  let ticks = BigInt(Math.floor(Date.now() / 1000)) + 11644473600n;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const data = new TextEncoder().encode(ticks.toString() + TOKEN);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    let text = (data && typeof data.text === "string") ? data.text.trim() : "";
    let voice = (data && typeof data.voice === "string") ? data.voice : DEFAULT_VOICE;
    if (voice.indexOf("edge:") === 0) voice = voice.slice(5);
    if (!ALLOWED.has(voice)) voice = DEFAULT_VOICE;
    if (!text) return new Response("missing text", { status: 400 });
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);

    // 엣지 캐시 (voice+text)
    let cache = null, cacheKey = null;
    try {
      cache = caches.default;
      cacheKey = new Request("https://edge-tts.local/" + encodeURIComponent(voice) + "/" + encodeURIComponent(text), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) { cache = null; }

    const gec = await secMsGec();
    // Workers의 outbound WebSocket 은 https:// 스킴 + Upgrade 헤더로 연결한다.
    const url = WSS.replace("wss://", "https://") + "?TrustedClientToken=" + TOKEN + "&Sec-MS-GEC=" + gec + "&Sec-MS-GEC-Version=" + GEC_VERSION;
    // Microsoft가 요구하는 헤더(Origin=Edge 읽어주기 확장 ID, User-Agent 등). 없으면 403.
    const WS_HEADERS = {
      "Upgrade": "websocket",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
    };
    let upstream;
    try { upstream = await fetch(url, { headers: WS_HEADERS }); }
    catch (e) { return jsonErr("edge connect failed", 502, String(e && e.message || e)); }
    const ws = upstream.webSocket;
    if (!ws) return jsonErr("edge ws upgrade failed", 502, "status " + upstream.status);
    ws.accept();

    const chunks = await new Promise((resolve, reject) => {
      const acc = [];
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(to); try { ws.close(); } catch (e) {} fn(arg); };
      const to = setTimeout(() => finish(reject, new Error("timeout")), 15000);
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          if (ev.data.indexOf("Path:turn.end") !== -1) finish(resolve, acc);
        } else {
          try {
            const buf = ev.data; // ArrayBuffer
            const dv = new DataView(buf);
            const headerLen = dv.getUint16(0);
            acc.push(new Uint8Array(buf.slice(2 + headerLen)));
          } catch (e) {}
        }
      });
      ws.addEventListener("close", () => finish(resolve, acc));
      ws.addEventListener("error", () => finish(reject, new Error("ws error")));

      const config = "X-Timestamp:" + new Date().toString() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } });
      ws.send(config);
      const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice name='" + voice + "'>" + xmlEsc(text) + "</voice></speak>";
      const msg = "X-RequestId:" + crypto.randomUUID().replace(/-/g, "") + "\r\nContent-Type:application/ssml+xml\r\n" +
        "X-Timestamp:" + new Date().toString() + "\r\nPath:ssml\r\n\r\n" + ssml;
      ws.send(msg);
    });

    let total = 0; chunks.forEach((c) => total += c.length);
    if (!total) return jsonErr("no audio", 502, "");
    const out = new Uint8Array(total); let off = 0;
    chunks.forEach((c) => { out.set(c, off); off += c.length; });
    const resp = new Response(out, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
    if (cache && cacheKey && context.waitUntil) { try { context.waitUntil(cache.put(cacheKey, resp.clone())); } catch (e) {} }
    return resp;
  } catch (e) {
    return jsonErr("edge tts error", 502, String(e && e.message || e));
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
