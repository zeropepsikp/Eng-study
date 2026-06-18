// Cloudflare Worker entry — 정적 자산 + /api 라우팅
// 정적 파일(public/)은 Static Assets 가 먼저 서빙하고,
// 자산에 없는 /api/* 요청만 이 Worker 가 처리한다.
// API 키는 Cloudflare 대시보드의 Variables and Secrets(런타임 시크릿)에서 읽는다.

import { onRequestPost as tutorChat } from "./api/tutor/chat.js";
import { onRequestPost as tutorTts } from "./api/tutor/tts.js";
import { onRequestPost as tutorImage } from "./api/tutor/image.js";
import { onRequestPost as openaiTts } from "./api/tts.js";

const ROUTES = {
  "/api/tutor/chat": tutorChat,
  "/api/tutor/tts": tutorTts,
  "/api/tutor/image": tutorImage,
  "/api/tts": openaiTts,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const handler = ROUTES[pathname];
    if (handler) {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const context = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
      return handler(context);
    }
    // 그 외 경로는 정적 자산으로 폴백 (보통은 Static Assets 가 이미 처리)
    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
