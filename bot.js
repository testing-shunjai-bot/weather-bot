import Anthropic from "@anthropic-ai/sdk";
import { Telegraf, Markup } from "telegraf";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;

const bot    = new Telegraf(TELEGRAM_TOKEN);
const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

const subscribers = new Set();

// ── System prompt ─────────────────────────────────────────
const SYSTEM = `你是一个专门分析 Polymarket 上海浦东机场最高气温预测市场的交易助手。

【结算规则】
- 结算数据：Wunderground ZSPD 气象站（非手机天气APP）
- METAR 报文记录华氏整数，WU 直接展示不换算
  例：20.3°C → 取整 69°F → 换回 20.6°C（结算值）
- 浦东机场比上海市区偏低 0.5–1.5°C（海风效应）

【预测方法】
1. WC + ECMWF 集成：晴天信WC，阴雨重云信ECMWF
2. 卡尔曼修正：早6点实测占20%→中午12点占72%→下午1点占85%
3. 升降温判断：冬季最准，秋季最差（63.7%）

【最高温出现时间】
- 通常 11:00–13:00，夏季12点最集中
- 雨天例外：峰值可能在夜间（暖湿气流）

【入场策略】
- 最佳窗口：上午9–12点（现在是最佳入场时间）
- 信号一致（凌晨趋势 + 实时云况）才入场
- 下午2点后直接看实测最高温

【不该下注】
- 秋季9–11月（接近抛硬币）
- 信号矛盾
- 档位已充分定价（价格已接近100%）`;

// ── Daily probability report prompt ──────────────────────
const DAILY_PROMPT = `请帮我分析今天和明天的 Polymarket 上海最高气温市场。

步骤：
1. 搜索今天上海浦东机场(ZSPD)实时天气：当前气温、云量、风速、今日已观测最高温
2. 搜索今天和明天上海天气预报（最高气温预测）
3. 搜索 Polymarket 上今天和明天"Highest temperature in Shanghai"市场的各档位定价

重要：回复中不要使用任何Markdown符号，不要用**、##、###、---等符号。只用纯文字和emoji。

然后对今天和明天各输出以下格式（纯文字）：

📅 [日期] 概率分析
━━━━━━━━━━━━━━━
天气类型：[晴天/阴天/雨天] | 趋势：[升温↑/降温↓/持平→]
预测最高温：[X]°C（METAR结算：[Y]°F → [Z]°C）

档位对比：
12°C 我方XX% | 市场XX% | 优势+X% | 🟢买YES
13°C 我方XX% | 市场XX% | 优势-X% | 🔴不操作
（只列出市场上有定价的档位）

✅ 最佳操作：押 [X°C] [YES/NO]，优势 [+X%]
⚠️ 风险：[一句话]

规则：
优势>10% → 🟢强烈推荐
优势5-10% → 🟡可以入场
优势<5% → 🔴不操作
下午2点后今天只显示实测结果不给建议`;

// ── Ask Claude ────────────────────────────────────────────
async function askClaude(messages) {
  const res = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: SYSTEM,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages,
  });
  return res.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ── Conversation history ──────────────────────────────────
const histories = new Map();
function getHistory(id) {
  if (!histories.has(id)) histories.set(id, []);
  return histories.get(id);
}
function addMsg(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > 20) histories.set(id, h.slice(-20));
}

// ── Send daily report ────────────────────────────────────
async function sendDailyReport(targetId) {
  const uids = targetId ? [targetId] : [...subscribers];
  if (uids.length === 0) return;
  try {
    const reply = await askClaude([{ role: "user", content: DAILY_PROMPT }]);
    const clean = reply.replace(/\*\*/g, "").replace(/#{1,3} /g, "").replace(/---/g, "━━━━━━━━━━━━━━━");
    const msg = "🌤 每日概率报告（上午9点）\n\n" + clean + "\n\n⏰ 最佳入场窗口：现在–12:00";
    for (const uid of uids) {
      await bot.telegram.sendMessage(uid, msg);
    }
  } catch(e) {
    console.error("Daily report error:", e.message);
    for (const uid of uids) {
      await bot.telegram.sendMessage(uid, "❌ 今日报告生成失败：" + e.message);
    }
  }
}

// ── Scheduler: 9:00 AM Shanghai = 01:00 UTC ──────────────
function scheduleDaily() {
  function msUntilNext9AM() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(1, 0, 0, 0); // 01:00 UTC = 09:00 CST
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }
  function loop() {
    sendDailyReport();
    setTimeout(loop, 24 * 60 * 60 * 1000);
  }
  const ms = msUntilNext9AM();
  console.log(`Daily report scheduled in ${Math.round(ms/60000)} min (9:00 AM Shanghai)`);
  setTimeout(loop, ms);
}

// ── Quick actions ─────────────────────────────────────────
const QUICK = [
  { label: "📊 今日+明日概率报告", msg: DAILY_PROMPT },
  { label: "📅 今天怎么押？",      msg: "只分析今天的市场。搜索今天ZSPD实时天气和Polymarket今天的定价，给出今天各档位概率对比和最佳操作。" },
  { label: "📅 明天怎么押？",      msg: "只分析明天的市场。搜索明天上海天气预报和Polymarket明天的定价，给出明天各档位概率对比和最佳操作。" },
  { label: "⏰ 现在能入场？",      msg: "现在几点？结合当前时间和今天实时天气，告诉我现在适不适合入场，信号是否一致。" },
  { label: "🔔 订阅每日9点报告",   msg: "__subscribe__" },
  { label: "🔕 取消订阅",          msg: "__unsubscribe__" },
  { label: "📐 结算规则",          msg: "解释METAR华氏取整结算规则，举例说明为什么手机天气APP会看错。" },
  { label: "🚫 何时不该押？",      msg: "哪些情况下应该直接跳过？" },
];

const keyboard = Markup.inlineKeyboard(
  QUICK.map((q, i) => [Markup.button.callback(q.label, String(i))])
);

// ── Handle any query ──────────────────────────────────────
async function handleQuery(ctx, userMsg) {
  const uid = ctx.from.id;
  if (userMsg === "__subscribe__") {
    subscribers.add(uid);
    await ctx.reply("✅ 已订阅！每天早上9点（上海时间）自动推送今日+明日概率报告。\n\n发送 /report 可立即获取今日报告。");
    return;
  }
  if (userMsg === "__unsubscribe__") {
    subscribers.delete(uid);
    await ctx.reply("🔕 已取消订阅每日报告。");
    return;
  }
  addMsg(uid, "user", userMsg);
  await ctx.sendChatAction("typing");
  try {
    const reply = await askClaude(getHistory(uid));
    addMsg(uid, "assistant", reply);
    // Strip any markdown symbols just in case
    const clean = reply.replace(/\*\*/g, "").replace(/#{1,3} /g, "").replace(/---/g, "━━━━━━━━━━━━━━━");
    await ctx.reply(clean);
  } catch(e) {
    await ctx.reply("出错了：" + e.message);
  }
}

// ── Bot handlers ──────────────────────────────────────────
bot.start(async ctx => {
  subscribers.add(ctx.from.id);
  await ctx.reply(
    "你好！我是你的 Polymarket 天气交易助手 🌤\n\n" +
    "每天早上 9:00（上海时间）我会自动发送：\n" +
    "• 今天+明天各档位概率\n" +
    "• 我方预测 vs 市场定价对比\n" +
    "• 明确的 YES/NO 操作建议\n" +
    "• 优势百分比\n\n" +
    "✅ 已为你开启每日9点推送\n" +
    "发送 /report 立即获取今日报告👇",
    keyboard
  );
});

bot.command("menu",        ctx => ctx.reply("选择操作：", keyboard));
bot.command("report",      ctx => sendDailyReport(ctx.from.id));
bot.command("subscribe",   ctx => { subscribers.add(ctx.from.id); ctx.reply("✅ 已订阅每日9点报告！"); });
bot.command("unsubscribe", ctx => { subscribers.delete(ctx.from.id); ctx.reply("🔕 已取消订阅。"); });
bot.command("clear",       ctx => { histories.delete(ctx.from.id); ctx.reply("✅ 对话历史已清除！"); });

QUICK.forEach((q, i) => {
  bot.action(String(i), async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply(`_${q.label}_`, { parse_mode: "Markdown" });
    await handleQuery(ctx, q.msg);
  });
});

bot.on("text", async ctx => handleQuery(ctx, ctx.message.text));

// ── Launch ────────────────────────────────────────────────
scheduleDaily();
bot.launch();
console.log("Bot 已启动 ✅ — 每日9点报告已排程");
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
