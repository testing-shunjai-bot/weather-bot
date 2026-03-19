import Anthropic from "@anthropic-ai/sdk";
import { Telegraf, Markup } from "telegraf";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;

const bot    = new Telegraf(TELEGRAM_TOKEN);
const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

const subscribers = new Set();

// ── System prompt ─────────────────────────────────────────
const SYSTEM = `你是Polymarket上海浦东机场最高气温市场交易助手。
结算用Wunderground ZSPD站METAR华氏整数（如69°F→20.6°C）。机场比市区低0.5-1.5°C。
峰值通常11-13点，雨天可能在夜间。最佳入场9-12点。
优势>10%强烈推荐，5-10%可入场，<5%不操作。
回复只用纯文字和emoji，不用**##等markdown符号。`;

// ── Daily probability report prompt ──────────────────────
const DAILY_PROMPT = `搜索以下信息并给出今明两天上海浦东气温市场分析：
1. 今天ZSPD实时天气（气温、云量）
2. 今明两天上海最高气温预报
3. Polymarket今明两天上海气温各档位定价

每天输出（纯文字无markdown）：
📅 [日期]
天气：[类型] 趋势：[升温↑/降温↓/持平→]
预测：[X]°C → METAR [Y]°F → 结算[Z]°C

[温度]°C 我方[X]% 市场[X]% 优势[+/-X%] [🟢买YES/🔴不操作]
（仅列有定价档位）

✅ 建议：[X°C] [YES/NO] 优势[+X%]
⚠️ 风险：[一句话]`;

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
