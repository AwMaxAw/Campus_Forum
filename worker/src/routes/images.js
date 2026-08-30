/**
 * 图片相关路由
 *
 * POST   /api/images              上传图片（JSON body: { image: "data:image/png;base64,...", filename?: "xxx.png" }）
 * GET    /api/images/:id          获取图片（返回二进制，带正确 Content-Type）
 * DELETE /api/images/:id          删除图片（JWT：上传者本人 或 ops_admin（运维管理员））
 * GET    /api/images/post/:postId 获取某帖子的全部图片（返回 JSON 列表，不含 data）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';

const images = new Hono();

function ok(data, extra) {
  return { success: true, data, ...(extra || {}) };
}
function fail(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function requireAuth() {
  return createMiddleware(async (c, next) => {
    const mw = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
    return mw(c, next);
  });
}

// 允许的 MIME 类型
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB 原始大小限制（前端会压缩，这是兜底）

/**
 * 从 data URL 中解析出 MIME 类型和 base64 数据
 * data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...
 */
function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const base64 = match[2];
  if (!ALLOWED_MIMES.has(mimeType)) return null;
  // 解码 base64
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mimeType, data: bytes, size: bytes.length };
  } catch {
    return null;
  }
}

// ==================== 上传图片（JWT）====================
images.post('/', requireAuth(), async (c) => {
  try {
    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    if (!uid) return fail('需要登录', 401);

    const db = c.env.DB;
    const author = await db
      .prepare('SELECT uid, role FROM users WHERE uid = ?')
      .bind(uid)
      .first();
    if (!author) return fail('用户不存在', 401);

    let body;
    try { body = await c.req.json(); } catch { return fail('请求体必须是合法 JSON'); }

    const imageDataUrl = body.image || body.data || '';
    if (!imageDataUrl) return fail('缺少图片数据');

    const parsed = parseDataUrl(imageDataUrl);
    if (!parsed) return fail('图片格式不支持，仅支持 PNG/JPEG/WebP/GIF');
    if (parsed.size > MAX_IMAGE_SIZE) return fail(`图片过大（${(parsed.size / 1024).toFixed(1)}KB），最大 5MB`);

    const filename = (body.filename || `image_${Date.now()}`).slice(0, 200);
    const { mimeType, data: imageBytes, size } = parsed;

    // 插入图片记录，data 以 BLOB 存储
    const result = await db
      .prepare(
        `INSERT INTO images (author_uid, filename, mime_type, size, data, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      )
      .bind(uid, filename, mimeType, size, imageBytes)
      .run();

    const imageId = result && result.meta && typeof result.meta.last_row_id === 'number'
      ? result.meta.last_row_id : null;
    if (!imageId) return fail('图片上传失败（DB 返回空 id）', 500);

    return c.json(ok({
      id: imageId,
      url: `/api/images/${imageId}`,
      mimeType,
      size,
    }), 201);
  } catch (e) {
    return fail(`[image upload] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 获取某帖子的图片列表（不含 data，公开）====================
images.get('/post/:postId', async (c) => {
  try {
    const postId = parseInt(c.req.param('postId'), 10);
    if (!Number.isFinite(postId) || postId <= 0) return fail('帖子 ID 无效');

    const db = c.env.DB;
    const rows = await db
      .prepare(
        `SELECT id, post_id, author_uid, filename, mime_type, size, width, height, created_at
         FROM images WHERE post_id = ? ORDER BY id ASC`
      )
      .bind(postId)
      .all();

    const imagesList = (rows.results || []).map(r => ({
      id: r.id,
      postId: r.post_id,
      url: `/api/images/${r.id}`,
      filename: r.filename,
      mimeType: r.mime_type,
      size: r.size,
      width: r.width,
      height: r.height,
      createdAt: r.created_at,
    }));

    return c.json(ok(imagesList));
  } catch (e) {
    return fail(`[images post list] ${e.name}: ${e.message}`, 500);
  }
});

// ==================== 获取图片（返回二进制流，公开）====================
images.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id) || id <= 0) return fail('图片 ID 无效');

  const db = c.env.DB;
  const row = await db
    .prepare('SELECT id, mime_type, size, data FROM images WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return fail('图片不存在', 404);

  // 检查 If-None-Match / ETag 做缓存优化
  const etag = `"${row.id}-${row.size}"`;
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  // D1 返回的 BLOB 可能是 ArrayBuffer、Uint8Array 或其他类型，统一转成 Uint8Array 二进制
  let binaryData = row.data;
  if (binaryData instanceof ArrayBuffer) {
    binaryData = new Uint8Array(binaryData);
  } else if (Array.isArray(binaryData)) {
    // D1 有时把 BLOB 返回为普通数组 [255, 216, ...]
    binaryData = new Uint8Array(binaryData);
  } else if (typeof binaryData === 'string') {
    // 最坏情况：逗号分隔的数字字符串 "255,216,..."
    binaryData = new Uint8Array(binaryData.split(',').map(Number));
  }

  return new Response(binaryData, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Length': String(binaryData.length),
      'Cache-Control': 'public, max-age=86400',
      'ETag': etag,
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// ==================== 删除图片（JWT：上传者本人 或 ops_admin（运维管理员））====================
images.delete('/:id', requireAuth(), async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return fail('图片 ID 无效');

    const payload = c.get('jwtPayload');
    const uid = payload && payload.sub;
    const role = payload && payload.role;
    if (!uid) return fail('需要登录', 401);

    const db = c.env.DB;
    const row = await db
      .prepare('SELECT id, author_uid FROM images WHERE id = ?')
      .bind(id)
      .first();
    if (!row) return fail('图片不存在', 404);

    const isAdmin = role === 'ops_admin';
    if (row.author_uid !== uid && !isAdmin) return fail('没有权限删除该图片', 403);

    await db.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
    return c.json(ok({ id, deleted: true }));
  } catch (e) {
    return fail(`[image delete] ${e.name}: ${e.message}`, 500);
  }
});

export default images;
