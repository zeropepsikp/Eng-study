// POST /api/tutor/video — Kling 이미지→영상 (튜터가 말하는 3~5초 영상, 1회성)
// Body: { action:"create", image:"data:...base64" }  → { task_id }
//       { action:"status", task_id:"..." }            → { status:"processing|succeed|failed", url? }
// 인증: KLING_ACCESS_KEY + KLING_SECRET_KEY 가 있으면 JWT(HS256), 없으면 KLING_API_KEY 를 Bearer 로 사용.
// 실패/미설정 시 JSON 오류 → 클라가 정적 이미지로 폴백.

const BASE = "https://api.klingai.com/v1/videos/image2video";
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
  if (env.KLING_API_KEY) return env.KLING_API_KEY; // 일부 프록시/JWT 직접 입력 케이스
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const token = await authToken(env);
    if (!token) return json({ error: "KLING key not configured" }, 500);

    let data;
    try { data = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const action = data && data.action;
    const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

    if (action === "create") {
      let image = (data && typeof data.image === "string") ? data.image : "";
      const comma = image.indexOf(",");
      if (image.indexOf("data:") === 0 && comma !== -1) image = image.slice(comma + 1); // base64 부분만
      if (!image) return json({ error: "missing image" }, 400);
      const body = {
        model_name: "kling-v1",
        mode: "std",
        duration: "5",
        image: image,
        prompt: TALK_PROMPT,
        cfg_scale: 0.5
      };
      const r = await fetch(BASE, { method: "POST", headers, body: JSON.stringify(body) });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      if (!r.ok || !j || !j.data || !j.data.task_id) {
        return json({ error: "kling create failed", status: r.status, detail: (j && j.message) || t.slice(0, 300) }, 502);
      }
      return json({ task_id: j.data.task_id });
    }

    if (action === "status") {
      const id = data && data.task_id;
      if (!id) return json({ error: "missing task_id" }, 400);
      const r = await fetch(BASE + "/" + encodeURIComponent(id), { method: "GET", headers });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      if (!r.ok || !j || !j.data) return json({ status: "processing" });
      const st = j.data.task_status; // submitted | processing | succeed | failed
      if (st === "succeed") {
        const vids = j.data.task_result && j.data.task_result.videos;
        const url = vids && vids[0] && vids[0].url;
        return json({ status: "succeed", url: url || "" });
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
