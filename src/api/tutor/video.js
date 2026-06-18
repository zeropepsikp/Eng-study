// POST /api/tutor/video — Kling 이미지→영상 (튜터가 말하는 ~5초 영상, 1회성)
// Body: { action:"create", image:"data:...base64" }  → { task_id }
//       { action:"status", task_id:"..." }            → { status, url? }
// 인증 우선순위:
//   1) KLING_ACCESS_KEY + KLING_SECRET_KEY  → JWT(HS256)
//   2) KLING_API_KEY 에 ":" 포함 (access:secret) → JWT
//   3) KLING_API_KEY 단일 → Bearer 그대로
// 실패 시 상세 오류 JSON 반환(클라가 화면에 표시).

const BASES = ["https://api-singapore.klingai.com", "https://api.klingai.com"];
const PATH = "/v1/videos/image2video";
const MODEL = "kling-v2-6";   // 공식 2.6 모델
const MODE = "std";           // std(저렴) / pro(고품질) — 필요시 변경
const TALK_PROMPT = "The person looks directly at the camera and talks naturally, gentle realistic lip movement, subtle friendly facial expressions, slight natural head movement and a small hand gesture, warm and lively, stable framing";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
}
function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) { return b64url(new TextEncoder().encode(str)); }

async function makeJwt(access, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: access, exp: now + 1800, nbf: now - 5 };
  const data = b64urlStr(JSON.stringify(header)) + "." + b64urlStr(JSON.stringify(payload));
  const keyObj = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", keyObj, new TextEncoder().encode(data));
  return data + "." + b64url(new Uint8Array(sig));
}
async function authToken(env) {
  if (env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY) return await makeJwt(env.KLING_ACCESS_KEY, env.KLING_SECRET_KEY);
  const k = env.KLING_API_KEY;
  if (k && k.indexOf(":") !== -1) { const i = k.indexOf(":"); return await makeJwt(k.slice(0, i), k.slice(i + 1)); }
  if (k) return k;
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const token = await authToken(env);
    if (!token) return json({ error: "KLING key not configured (KLING_ACCESS_KEY+KLING_SECRET_KEY 또는 KLING_API_KEY)" }, 500);

    let data;
    try { data = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const action = data && data.action;
    const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

    if (action === "create") {
      let image = (data && typeof data.image === "string") ? data.image : "";
      const comma = image.indexOf(",");
      if (image.indexOf("data:") === 0 && comma !== -1) image = image.slice(comma + 1);
      if (!image) return json({ error: "missing image" }, 400);
      const body = JSON.stringify({ model_name: MODEL, image, prompt: TALK_PROMPT, negative_prompt: "", duration: "5", mode: MODE, sound: "off" });

      const errs = [];
      for (let i = 0; i < BASES.length; i++) {
        let r, t;
        try { r = await fetch(BASES[i] + PATH, { method: "POST", headers, body }); t = await r.text(); }
        catch (e) { errs.push(BASES[i] + ": network"); continue; }
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        if (r.ok && j && j.data && j.data.task_id) return json({ task_id: i + "|" + j.data.task_id });
        errs.push(BASES[i] + " (" + r.status + "): " + ((j && (j.message || (j.error && j.error.message))) || t.slice(0, 160)));
      }
      return json({ error: "kling create failed", detail: errs.join(" || ") }, 502);
    }

    if (action === "status") {
      const raw = (data && data.task_id) || "";
      const bar = raw.indexOf("|");
      const idx = bar > -1 ? parseInt(raw.slice(0, bar), 10) || 0 : 0;
      const id = bar > -1 ? raw.slice(bar + 1) : raw;
      if (!id) return json({ error: "missing task_id" }, 400);
      const base = BASES[idx] || BASES[0];
      const r = await fetch(base + PATH + "/" + encodeURIComponent(id), { method: "GET", headers });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      if (!r.ok || !j || !j.data) return json({ status: "processing" });
      const st = j.data.task_status; // submitted | processing | succeed | failed
      if (st === "succeed") {
        const vids = j.data.task_result && j.data.task_result.videos;
        return json({ status: "succeed", url: (vids && vids[0] && vids[0].url) || "" });
      }
      if (st === "failed") return json({ status: "failed", detail: j.data.task_status_msg || "" });
      return json({ status: "processing" });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: "server error", detail: String(e && e.message || e) }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
