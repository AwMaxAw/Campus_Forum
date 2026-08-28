// Cloudflare Pages Functions - 反向代理 /api/* → Worker
// 前端 fetch('/api/auth/register') 被代理到 Worker，同域零 CORS 问题
const WORKER_BASE = 'https://campus-forum.max-li-ggm.workers.dev';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, WORKER_BASE);

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set('Host', 'campus-forum.max-li-ggm.workers.dev');
  forwardHeaders.delete('cf-connecting-ip');
  forwardHeaders.delete('origin');
  forwardHeaders.delete('referer');

  const res = await fetch(target.toString(), {
    method: request.method,
    headers: forwardHeaders,
    body: request.body,
    redirect: 'follow',
  });

  return new Response(res.body, res);
}
