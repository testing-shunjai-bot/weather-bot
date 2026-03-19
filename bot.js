// 安装依赖：npm install telegraf @anthropic-ai/sdk

import Anthropic from "@anthropic-ai/sdk";
import { Telegraf, Markup } from "telegraf";

// ── 配置 ────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;

// ── 客户端 ───────────────────────────────────────────────
const bot    = new Telegraf(TELEGRAM_TOKEN);
const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── 系统提示 ─────────────────────────────────────────────
const SYSTEM = `你是一个专门分析 Polymarket 天气预测市场的交易助手，基于以下核心知识：

【结算规则】
- Polymarket 上海浦东机场最高气温市场，结算数据来源是 Wunderground 的 ZSPD 气象站
- 温度格式：METAR 报文记录华氏整数，WU 直接展示，不换算
  例：20.3°C → 68.54°F → 取整 69°F → 换回 20.6°C（这才是结算值）
- 浦东机场受海风影响，通常比上海市区偏低 0.5–1.5°C

【预测方法】
1. WC + ECMWF 集成预报：晴天信 Weather Company，云量大/风速高信 ECMWF
2. 卡尔曼增益修正：早6点实测占20%，中午12点占72%，下午1点占85%
3. 升降温日判断：凌晨看气压变化、风向风速、云况、近三天趋势
   冬季最准，秋季最差（仅63.7%准确率）

【历史规律】
- 上海最高气温集中出现在 11:00–13:00
- 夏季12:00集中度最高，单小时占全季27.6%
- 秋季峰值略早，10:00也是高频时段

【入场策略】
- 最佳入场窗口：上午9点–12点
- 不在早盘直接买热门档位（已被充分定价）
- 等凌晨趋势信号 + 上午实时数据方向一致才入场
- 下午2点后峰值已过，直接看今日实测最高温

【信号逻辑】
- 降温日 + 重云(>70%) → 押低档位 YES
- 升温日 + 晴天(<40%云) → 押高档位 YES
- 雨天特殊：峰值可能在夜间，不能用晴天逻辑
- 13点后锁定今日实测最高温

【不该下注】
- 秋季（9–11月）：准确率接近抛硬币
- 信号矛盾时
- 市场已充分定价
- 下午2点后才发现信号

回答用中文，简洁直接。给建议时格式：
1. 今日天气类型
2. 预测档位
3. 操作建议（押哪个档位 YES/NO，何时入场）
4. 风险提示

如需当前天气数据，主动用 web_search 搜索 "Shanghai Pudong Airport ZSPD weather today"。`;

// ── 快捷指令 ─────────────────────────────────────────────
const QUICK = [
  { label: "📊 今天怎么押？",   msg: "今天上海浦东机场最高气温应该押哪个档位？帮我搜索当前天气数据给出完整建议。" },
  { label: "⏰ 现在能入场？",   msg: "现在几点了，当前时间窗口适合入场Polymarket天气市场吗？" },
  { label: "🌧 下雨怎么判断？", msg: "今天上海在下雨，我该怎么调整预测策略？" },
  { label: "📐 结算规则",       msg: "帮我详细解释METAR华氏取整的结算规则，举个例子。" },
  { label: "🚫 何时不该押？",   msg: "哪些情况下应该直接跳过不下注？" },
  { label: "🔢 算优势",         msg: "Polymarket上12°C档位定价55%，我该怎么判断要不要进？" },
];

const keyboard = Markup.inlineKeyboard(
  QUICK.map((q, i) => [Markup.button.callback(q.label, String(i))])
);

// ── 对话历史 ─────────────────────────────────────────────
const histories = new Map();

function getHistory(id) {
  if (!histories.has(id)) histories.set(id, []);
  return histories.get(id);
}

function addMessage(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > 20) histories.set(id, h.slice(-20));
}

// ── Claude 调用 ──────────────────────────────────────────
async function askClaude(userId) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: SYSTEM,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: getHistory(userId),
  });
  return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ── Bot 处理 ─────────────────────────────────────────────
bot.start(async ctx => {
  await ctx.reply(
    "你好！我是你的 Polymarket 天气交易助手 🌤\n\n" +
    "我熟悉 Biteye 文章的整套逻辑：\n" +
    "• ZSPD 结算规则 & METAR 华氏取整\n" +
    "• 卡尔曼融合预测\n" +
    "• 升降温判断 & 入场时机\n\n" +
    "直接发消息问我，或点快捷按钮👇",
    keyboard
  );
});

bot.command("menu",  ctx => ctx.reply("选择快捷操作：", keyboard));
bot.command("clear", ctx => {
  histories.delete(ctx.from.id);
  ctx.reply("✅ 对话历史已清除！");
});

// 快捷按钮
QUICK.forEach((q, i) => {
  bot.action(String(i), async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply(`_${q.label}_`, { parse_mode: "Markdown" });
    const uid = ctx.from.id;
    addMessage(uid, "user", q.msg);
    await ctx.sendChatAction("typing");
    try {
      const reply = await askClaude(uid);
      addMessage(uid, "assistant", reply);
      await ctx.reply(reply);
    } catch (e) {
      await ctx.reply("出错了：" + e.message);
    }
  });
});

// 普通消息
bot.on("text", async ctx => {
  const uid  = ctx.from.id;
  const text = ctx.message.text;
  addMessage(uid, "user", text);
  await ctx.sendChatAction("typing");
  try {
    const reply = await askClaude(uid);
    addMessage(uid, "assistant", reply);
    await ctx.reply(reply);
  } catch (e) {
    await ctx.reply("出错了：" + e.message);
  }
});

bot.launch();
console.log("Bot 已启动 ✅");
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
