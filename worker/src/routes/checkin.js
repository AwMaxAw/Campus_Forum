/**
 * 每日签到
 *
 * POST   /api/checkin              执行签到（JWT）
 * GET    /api/checkin/calendar     获取某月签到记录（JWT，query: year, month）
 */

import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { createMiddleware } from 'hono/factory';
import { EXP, addExp } from '../utils/exp.js';

const checkin = new Hono();

function ok(data, extra) { return { success: true, data, ...(extra || {}) }; }
function fail(message, status = 400) {
  return new Response(JSON.stringify({ success: false, message }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function requireAuth() {
  return createMiddleware(async (c, next) => {
    const mw = jwt({ secret: c.env.JWT_SECRET, alg: 'HS256' });
    return mw(c, next);
  });
}

// UTC 日期字符串 YYYY-MM-DD
function utcToday() { return new Date().toISOString().slice(0, 10); }
function utcDateOf(daysOffset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

// ==================== 执行签到 ====================
checkin.post('/', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const db = c.env.DB;
  const today = utcToday();

  // 1) 是否今日已签（唯一性约束兜底）
  const existing = await db
    .prepare('SELECT 1 FROM check_ins WHERE uid = ? AND check_date = ?')
    .bind(uid, today).first();
  if (existing) {
    return fail('今日已签到，明天再来吧～', 409);
  }

  // 2) 算连续签到天数：查询最近一次签到日期
  const lastCheckin = await db
    .prepare('SELECT check_date FROM check_ins WHERE uid = ? ORDER BY check_date DESC LIMIT 1')
    .bind(uid).first();

  let streak = 1; // 今日第一次签到 = 连续 1 天
  if (lastCheckin) {
    const lastDate = lastCheckin.check_date;
    const yesterday = utcDateOf(-1);
    if (lastDate === yesterday) {
      // 昨天刚签，连续 +1
      const u = await db.prepare('SELECT checkin_streak FROM users WHERE uid = ?').bind(uid).first();
      streak = Math.min(99, (u && u.checkin_streak || 0) + 1);
    } else if (lastDate !== today) {
      // 中间断了（不是昨天也不是今天），重新从 1 开始
      streak = 1;
    }
  }

  // 3) 算积分：基础 3 + 每连续 7 天额外 +2
  let gained = EXP.CHECKIN_BASE;
  if (streak >= EXP.CHECKIN_STREAK_DAYS && streak % EXP.CHECKIN_STREAK_DAYS === 0) {
    gained += EXP.CHECKIN_STREAK_BONUS;
  }

  // 4) 写签到记录 + 更新 streak（batch 原子）
  await db.batch([
    db.prepare('INSERT INTO check_ins (uid, check_date, exp_delta) VALUES (?, ?, ?)').bind(uid, today, gained),
    db.prepare('UPDATE users SET checkin_streak = ? WHERE uid = ?').bind(streak, uid),
  ]);

  // 5) 加分 + 系统通知
  await addExp(db, uid, gained, 'checkin', `每日签到成功（连续 ${streak} 天）`);

  return c.json(ok({
    date: today,
    gained,
    streak,
    isBonusDay: streak >= EXP.CHECKIN_STREAK_DAYS && streak % EXP.CHECKIN_STREAK_DAYS === 0,
  }));
});

// ==================== 签到日历（某月签到记录）====================
checkin.get('/calendar', requireAuth(), async (c) => {
  const payload = c.get('jwtPayload');
  const uid = payload && payload.sub;
  if (!uid) return fail('需要登录', 401);

  const { searchParams } = new URL(c.req.url);
  const year = parseInt(searchParams.get('year') || String(new Date().getUTCFullYear()), 10);
  const month = parseInt(searchParams.get('month') || String(new Date().getUTCMonth() + 1), 10);
  if (!year || !month || month < 1 || month > 12) return fail('年月参数无效');

  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`; // 下月 1 号（exclusive）

  const db = c.env.DB;
  const rows = await db
    .prepare('SELECT check_date, exp_delta FROM check_ins WHERE uid = ? AND check_date >= ? AND check_date < ? ORDER BY check_date ASC')
    .bind(uid, start, end).all();

  // 查连续天数 + 是否今日已签
  const u = await db.prepare('SELECT checkin_streak FROM users WHERE uid = ?').bind(uid).first();
  const todayChecked = await db
    .prepare('SELECT 1 FROM check_ins WHERE uid = ? AND check_date = ?')
    .bind(uid, utcToday()).first();

  return c.json(ok({
    year, month,
    checkedDates: rows.results.map(r => ({ date: r.check_date, expDelta: r.exp_delta })),
    streak: u ? (u.checkin_streak || 0) : 0,
    todayChecked: !!todayChecked,
  }));
});

export default checkin;
