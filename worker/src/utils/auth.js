/**
 * 认证工具（零第三方依赖，只用 Web Crypto API）
 *
 * 密码哈希：PBKDF2-HMAC-SHA-256
 *   - 16 字节随机 salt
 *   - 100,000 次迭代（OWASP 2023 推荐下限）
 *   - 存储格式：`pbkdf2_sha256$100000$<salt_hex>$<hash_hex>`
 *     每段 $ 分隔，将来换算法只加新前缀，老密码可平滑迁移。
 *
 * Token：HMAC-SHA-256 JWT（Hono 内置）
 *   - payload: { sub: uid, role, iat, exp }
 *   - secret 通过 Workers Secrets（wrangler secret put JWT_SECRET）注入。
 */

const PBKDF2_ALGO = 'PBKDF2';
const HMAC_ALGO = 'SHA-256';
const ITERATIONS = 100000;
const KEY_LEN_BITS = 256;
const SALT_BYTES = 16;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  if (hex.length % 2 !== 0) throw new Error('hex 长度不对');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

// ==================== 密码哈希 ====================

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(password),
    { name: PBKDF2_ALGO },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: PBKDF2_ALGO,
      salt,
      iterations: ITERATIONS,
      hash: HMAC_ALGO,
    },
    baseKey,
    KEY_LEN_BITS
  );
  return `pbkdf2_sha256$${ITERATIONS}$${bufToHex(salt.buffer)}$${bufToHex(derived)}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  // 只支持我们自己生成的 pbkdf2_sha256 格式
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;

  const iterations = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const hashHex = parts[3];
  if (!iterations || !saltHex || !hashHex) return false;

  try {
    const salt = hexToBuf(saltHex);
    const expected = hexToBuf(hashHex);
    const baseKey = await crypto.subtle.importKey(
      'raw',
      ENCODER.encode(password),
      { name: PBKDF2_ALGO },
      false,
      ['deriveBits']
    );
    const derived = await crypto.subtle.deriveBits(
      {
        name: PBKDF2_ALGO,
        salt: new Uint8Array(salt),
        iterations,
        hash: HMAC_ALGO,
      },
      baseKey,
      expected.byteLength * 8
    );
    // 恒时比较（避免时序攻击）
    const a = new Uint8Array(derived);
    const b = new Uint8Array(expected);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// ==================== UID 校验 ====================
export function isUidValid(uid) {
  // 新格式：YY(2) + Campus(1) + SchoolLevel(1) + Class(2) + StudentNo(2) = 8 位
  // YY: 26, Campus: 1=广五本部 2=金碧校区, SchoolLevel: 1=初中 2=高中
  return typeof uid === 'string' && /^26[12][12]\d{4}$/.test(uid);
}

// ==================== 用户序列化（返回给前端的用户对象） ====================
export function serializeUser(row) {
  if (!row) return null;
  return {
    uid: row.uid,
    nickname: row.nickname,
    role: row.role,
    avatarUrl: row.avatar_url || null,
    bio: row.bio || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

// ==================== JWT 辅助：手动 + Hono sign 都行 ====================
// 这里导出常量，具体签/验在路由层用 hono/jwt
export const JWT_TTL_SEC = 7 * 24 * 60 * 60; // 7 天
