// POST /api/tutor/drill — 청크 기반 3턴 미니대화 생성 (Gemini 2.5 Flash, JSON)
// Body: { chunk_en, chunk_ko, examples:[".."], variant }
// 출력: A가 말 → 내가(YOU) 그 청크를 써서 답 → A가 반응. (한/영)
// 키: GEMINI_KEY. 실패 시 비-200 → 클라가 폴백(예문 기반 간이 대화).

const MODEL = "gemini-2.5-flash";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    a1_en: { type: "STRING" }, a1_ko: { type: "STRING" },
    you_en: { type: "STRING" }, you_ko: { type: "STRING" },
    a2_en: { type: "STRING" }, a2_ko: { type: "STRING" }
  },
  required: ["a1_en", "a1_ko", "you_en", "you_ko", "a2_en", "a2_ko"]
};

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const key = env.GEMINI_KEY;
    if (!key) return new Response("GEMINI_KEY not configured", { status: 500 });

    let data;
    try { data = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
    const chunkEn = String((data && data.chunk_en) || "").slice(0, 80);
    const chunkKo = String((data && data.chunk_ko) || "").slice(0, 120);
    const examples = Array.isArray(data && data.examples) ? data.examples.slice(0, 4).join(" / ") : "";
    const variant = parseInt((data && data.variant), 10) || 1;
    if (!chunkEn) return new Response("missing chunk", { status: 400 });

    const sys = "You are an English conversation coach for a Korean intermediate learner. " +
      "Create a natural, realistic 3-turn mini-conversation that practices the target expression. " +
      "Turn 1 = the other person (A) opens. Turn 2 = the LEARNER (YOU) replies and the line MUST naturally use the target expression. " +
      "Turn 3 = A responds briefly. Keep it conversational and short (each line 1 sentence). " +
      "Use intermediate-level vocabulary, natural and not too easy, but never obscure. " +
      "Make each variant a clearly different situation/context. " +
      "Provide faithful natural Korean translations. 'you_ko' must be a natural Korean version of the YOU line so the learner can try to produce the English. " +
      "Output ONLY the JSON object.";
    const user = "Target expression: \"" + chunkEn + "\" (" + chunkKo + ")\n" +
      (examples ? ("Example uses: " + examples + "\n") : "") +
      "Variant #" + variant + " — make this scenario different from other variants.";

    const body = {
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 1.0, responseMimeType: "application/json", responseSchema: SCHEMA }
    };
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + encodeURIComponent(key);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      let detail = ""; try { detail = (await r.text()).slice(0, 200); } catch (e) {}
      return new Response(JSON.stringify({ error: "gemini drill", status: r.status, detail: detail }), { status: r.status === 429 ? 429 : 502, headers: { "Content-Type": "application/json" } });
    }
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!txt) return new Response("no content", { status: 502 });
    return new Response(txt, { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response("error", { status: 500 });
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405 });
}
