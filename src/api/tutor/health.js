// POST/GET /api/tutor/health — 제미니 키 활성화 상태 점검
// { key:bool, chat:bool, tts:bool } 반환. 키로 모델 목록을 조회해 모델 접근 가능 여부를 본다.

async function check(env) {
  const key = env.GEMINI_KEY;
  if (!key) return { key: false, chat: false, tts: false };
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(key) + "&pageSize=200");
    if (!r.ok) return { key: true, chat: false, tts: false, status: r.status };
    const j = await r.json();
    const names = (j && j.models || []).map((m) => String(m.name || ""));
    const has = (frag) => names.some((n) => n.indexOf(frag) !== -1);
    return {
      key: true,
      chat: has("gemini-2.5-flash"),
      tts: has("gemini-2.5-flash-preview-tts") || has("flash-preview-tts") || has("tts")
    };
  } catch (e) {
    return { key: true, chat: false, tts: false, error: String(e && e.message || e) };
  }
}

export async function onRequest(context) {
  const res = await check(context.env);
  return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
