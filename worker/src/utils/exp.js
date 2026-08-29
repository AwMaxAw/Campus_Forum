/**
 * 等级积分系统（纯计算 + 数据库原子加分工具，无副作用依赖）
 *
 * 设计：
 *   - users 表持有 exp_points（累计积分，只增不减）
 *   - 等级依据累计积分查表得到；前端用同一套阈值表算 level/进度
 *   - 行为积分：发帖 / 评论 / 被点赞 / 被回复 / 浏览
 *   - 加分时同步写入一条系统通知（notifications 表），用户可在导航栏消息铃铛查看
 *
 * 计分规则（EXP）：
 *   发帖 +5 ｜ 评论 +2 ｜ 帖子被点赞 +3（给帖作者）｜ 评论被回复 +1 ｜ 浏览帖子 +1（每日上限 10）
 *
 * 等级阈值（累计积分达到即升级，基数小故阈值偏小）：
 *   Lv1=0  Lv2=20  Lv3=50  Lv4=90  Lv5=150
 *   Lv6=230  Lv7=330  Lv8=460  Lv9=620  Lv10=820
 *   超过 Lv10 后每级 +220（Lv11=1040, Lv12=1260 ...）
 */

// 累计积分 → 升级阈值。index 0 = Lv1 起点（0 分）。
// 这个表必须与前端 js/api.js 的 LEVEL_THRESHOLDS 完全一致。
export const LEVEL_THRESHOLDS = [0, 20, 50, 90, 150, 230, 330, 460, 620, 820];
// 超过表内最高阈值后，每升一级所需的额外积分
export const LEVEL_STEP_BEYOND = 220;

// 行为积分（加分点）
export const EXP = {
  POST: 5,                // 发帖
  COMMENT: 2,             // 评论
  LIKED: 3,               // 帖子被点赞（加给帖作者，自己赞自己不加分）
  REPLIED: 1,             // 评论被他人回复（加给被回复评论的作者）
  BROWSE: 1,              // 浏览帖子
  BROWSE_DAILY_LIMIT: 10, // 每日浏览积分上限（防刷）
};

/**
 * 依据累计积分算等级信息（前端/后端共用同一逻辑，不再返回头衔）。
 * @param {number} expRaw
 * @returns {{level:number,currentBase:number,nextBase:number,exp:number,progress:number,toNext:number}}
 */
export function getLevelInfo(expRaw) {
  const exp = Math.max(0, Math.floor(Number(expRaw) || 0));
  const lastIdx = LEVEL_THRESHOLDS.length - 1;
  const lastThreshold = LEVEL_THRESHOLDS[lastIdx];

  let level = 1;
  let currentBase = 0;
  let nextBase = LEVEL_THRESHOLDS[1] ?? LEVEL_THRESHOLDS[0] + LEVEL_STEP_BEYOND;

  if (exp < lastThreshold) {
    // 表内区间
    for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
      if (exp >= LEVEL_THRESHOLDS[i]) {
        level = i + 1;
        currentBase = LEVEL_THRESHOLDS[i];
        nextBase = i + 1 < LEVEL_THRESHOLDS.length
          ? LEVEL_THRESHOLDS[i + 1]
          : LEVEL_THRESHOLDS[i] + LEVEL_STEP_BEYOND;
      } else {
        break;
      }
    }
  } else {
    // 超过表内最高阈值，按 LEVEL_STEP_BEYOND 递增
    level = LEVEL_THRESHOLDS.length;
    currentBase = lastThreshold;
    while (exp >= currentBase + LEVEL_STEP_BEYOND) {
      currentBase += LEVEL_STEP_BEYOND;
      level += 1;
    }
    nextBase = currentBase + LEVEL_STEP_BEYOND;
  }

  const progress = nextBase > currentBase
    ? Math.max(0, Math.min(1, (exp - currentBase) / (nextBase - currentBase)))
    : 1;
  return { level, currentBase, nextBase, exp, progress, toNext: Math.max(0, nextBase - exp) };
}

/**
 * 给用户加分，并同步写入一条系统通知（notifications 表）。
 * 用 D1 batch 保证两条语句原子执行（都成功或都失败）。
 *
 * @param {D1Database} db
 * @param {string} uid          被加分的用户
 * @param {number} delta        积分变化（正数）
 * @param {string} type         通知类型：post / comment / liked / replied
 * @param {string} actionText   动作描述，用于拼通知正文，如"发布了帖子"
 */
export async function addExp(db, uid, delta, type = 'exp', actionText = '操作') {
  if (!uid || !delta) return;
  try {
    const content = `${actionText}，获得 ${delta} 积分`;
    await db.batch([
      db.prepare('UPDATE users SET exp_points = exp_points + ? WHERE uid = ?').bind(delta, uid),
      db.prepare(
        'INSERT INTO notifications (uid, type, content, exp_delta, is_read) VALUES (?, ?, ?, ?, 0)'
      ).bind(uid, type, content, delta),
    ]);
  } catch (e) {
    console.warn('[exp] addExp 失败：', e && e.message);
  }
}

/**
 * 浏览积分（每日上限 BROWSE_DAILY_LIMIT，跨天重置计数）。
 * 在帖子详情接口调用：已登录用户每打开一个帖子都可能 +1，但单日最多 10 分。
 * 浏览积分不发系统通知（避免刷屏），只累加 exp_points。
 * @returns {number} 实际加的分（0 表示已达上限或失败）
 */
export async function addBrowseExp(db, uid) {
  if (!uid) return 0;
  try {
    // 用 UTC 日期作为"天"边界（简化，不依赖时区配置）
    const today = new Date().toISOString().slice(0, 10);
    const u = await db
      .prepare('SELECT exp_daily_date, exp_daily_browse FROM users WHERE uid = ?')
      .bind(uid).first();
    if (!u) return 0;

    if (u.exp_daily_date !== today) {
      // 跨天：重置当日计数并加分
      await db.prepare(
        'UPDATE users SET exp_points = exp_points + ?, exp_daily_date = ?, exp_daily_browse = 1 WHERE uid = ?'
      ).bind(EXP.BROWSE, today, uid).run();
      return EXP.BROWSE;
    }
    if ((u.exp_daily_browse || 0) >= EXP.BROWSE_DAILY_LIMIT) return 0;
    await db.prepare(
      'UPDATE users SET exp_points = exp_points + ?, exp_daily_browse = exp_daily_browse + 1 WHERE uid = ?'
    ).bind(EXP.BROWSE, uid).run();
    return EXP.BROWSE;
  } catch (e) {
    console.warn('[exp] addBrowseExp 失败：', e && e.message);
    return 0;
  }
}
