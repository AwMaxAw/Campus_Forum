/**
 * 等级积分系统（纯计算 + 数据库原子加分工具，无副作用依赖）
 *
 * 设计：
 *   - users 表持有 exp_points（累计积分，只增不减）
 *   - 等级依据累计积分查表得到；前端用同一套阈值表算 level/进度
 *   - 行为积分：发帖 / 评论 / 被点赞 / 被回复 / 浏览
 *
 * 计分规则（EXP）：
 *   发帖 +5 ｜ 评论 +2 ｜ 帖子被点赞 +3（给帖作者）｜ 评论被回复 +1 ｜ 浏览帖子 +1（每日上限 10）
 *
 * 等级阈值（累计积分达到即升级）：
 *   Lv1=0  Lv2=100  Lv3=300  Lv4=600  Lv5=1000
 *   Lv6=1500  Lv7=2100  Lv8=2800  Lv9=3600  Lv10=4500
 *   超过 Lv10 后每级 +1000（Lv11=5500, Lv12=6500 ...）
 */

// 累计积分 → 升级阈值。index 0 = Lv1 起点（0 分）。
// 这个表必须与前端 js/api.js 的 LEVEL_THRESHOLDS 完全一致。
export const LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500];

// 行为积分（加分点）
export const EXP = {
  POST: 5,                // 发帖
  COMMENT: 2,             // 评论
  LIKED: 3,               // 帖子被点赞（加给帖作者，自己赞自己不加分）
  REPLIED: 1,             // 评论被他人回复（加给被回复评论的作者）
  BROWSE: 1,              // 浏览帖子
  BROWSE_DAILY_LIMIT: 10, // 每日浏览积分上限（防刷）
};

// 等级头衔（展示用，超出范围回退到 `Lv.N`）
export const LEVEL_TITLES = [
  '新手', '学徒', '常客', '熟手', '达人',
  '专家', '导师', '元老', '宗师', '传说',
];

/**
 * 依据累计积分算等级信息（前端/后端共用同一逻辑）。
 * @param {number} expRaw
 * @returns {{level:number,currentBase:number,nextBase:number,exp:number,progress:number,toNext:number,title:string}}
 */
export function getLevelInfo(expRaw) {
  const exp = Math.max(0, Math.floor(Number(expRaw) || 0));
  const lastIdx = LEVEL_THRESHOLDS.length - 1;
  const lastThreshold = LEVEL_THRESHOLDS[lastIdx];

  let level = 1;
  let currentBase = 0;
  let nextBase = LEVEL_THRESHOLDS[1] ?? LEVEL_THRESHOLDS[0] + 1000;

  if (exp < lastThreshold) {
    // 表内区间
    for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
      if (exp >= LEVEL_THRESHOLDS[i]) {
        level = i + 1;
        currentBase = LEVEL_THRESHOLDS[i];
        nextBase = i + 1 < LEVEL_THRESHOLDS.length
          ? LEVEL_THRESHOLDS[i + 1]
          : LEVEL_THRESHOLDS[i] + 1000;
      } else {
        break;
      }
    }
  } else {
    // 超过表内最高阈值，按每级 +1000 递增
    level = LEVEL_THRESHOLDS.length;
    currentBase = lastThreshold;
    while (exp >= currentBase + 1000) {
      currentBase += 1000;
      level += 1;
    }
    nextBase = currentBase + 1000;
  }

  const progress = nextBase > currentBase
    ? Math.max(0, Math.min(1, (exp - currentBase) / (nextBase - currentBase)))
    : 1;
  const title = LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)] || `Lv.${level}`;
  return { level, currentBase, nextBase, exp, progress, toNext: Math.max(0, nextBase - exp), title };
}

/**
 * 给用户加分（原子 UPDATE）。失败只 warn，不阻塞调用方主流程。
 * @param {D1Database} db
 * @param {string} uid
 * @param {number} delta
 */
export async function addExp(db, uid, delta) {
  if (!uid || !delta) return;
  try {
    await db.prepare('UPDATE users SET exp_points = exp_points + ? WHERE uid = ?').bind(delta, uid).run();
  } catch (e) {
    console.warn('[exp] addExp 失败：', e && e.message);
  }
}

/**
 * 浏览积分（每日上限 BROWSE_DAILY_LIMIT，跨天重置计数）。
 * 在帖子详情接口调用：已登录用户每打开一个帖子都可能 +1，但单日最多 10 分。
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
