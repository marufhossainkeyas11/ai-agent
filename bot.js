const { Bot, InputFile } = require("grammy");
const Anthropic = require("@anthropic-ai/sdk");
const http = require("http");
require("dotenv").config();

// ==== এখানে দুটো জিনিস বসান (নিচে .env ফাইলেও করা যায়, ওটাই ভালো) ====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; // Render নিজে থেকেই এটা সেট করে দেয়

if (!TELEGRAM_BOT_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("❌ .env ফাইলে TELEGRAM_BOT_TOKEN বা ANTHROPIC_API_KEY নেই!");
  process.exit(1);
}

// ==== Render Web Service এর জন্য ছোট HTTP server ====
// Render ফ্রি টিয়ারে "Web Service" টাইপ একটা খোলা পোর্ট চায়, নাহলে ডিপ্লয় fail দেখাবে।
// এই সার্ভার শুধু "আমি জীবিত আছি" বলার জন্য, বটের আসল কাজের সাথে সম্পর্কহীন।
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running.");
  })
  .listen(PORT, () => console.log(`🌐 Health check server on port ${PORT}`));

// ==== ফ্রি টিয়ার ১৫ মিনিট idle থাকলে ঘুমিয়ে যায়, তাই নিজেকে নিজে মাঝেমধ্যে ping করছে ====
// এটা ১০০% গ্যারান্টি না (Render মাঝেমধ্যে তাও ঘুমাতে পারে), কিন্তু সাহায্য করে।
if (RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(RENDER_EXTERNAL_URL).catch(() => {});
  }, 10 * 60 * 1000); // প্রতি ১০ মিনিটে
}

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ==== মেমরি: প্রতিটা চ্যাট আইডির জন্য আলাদা হিস্ট্রি (in-memory, সহজ) ====
// bot রিস্টার্ট হলে মেমরি মুছে যাবে — persistent memory চাইলে পরে বলবেন, JSON file বা DB দিয়ে করা যায়
const chatHistories = new Map();
const MAX_HISTORY = 20; // কতগুলো মেসেজ মনে রাখবে (বেশি রাখলে খরচ বাড়ে)

function getHistory(chatId) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  return chatHistories.get(chatId);
}

function pushHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
}

// ==== টেক্সট মেসেজ হ্যান্ডলার ====
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const userText = ctx.message.text;

  // /clear কমান্ড দিয়ে মেমরি মুছে ফেলা যাবে
  if (userText === "/clear") {
    chatHistories.delete(chatId);
    await ctx.reply("✅ মেমরি মুছে ফেলা হয়েছে।");
    return;
  }
  if (userText === "/start") {
    await ctx.reply("👋 হ্যালো! আমি Claude AI বট। টেক্সট লিখুন, ছবি পাঠান, বা প্রশ্ন করুন — যা খুশি জিজ্ঞেস করতে পারেন।\n\nমেমরি মুছতে: /clear");
    return;
  }

  try {
    await ctx.replyWithChatAction("typing");
    pushHistory(chatId, "user", userText);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      // ওয়েব সার্চ চালু — Claude নিজে বুঝে নেবে কখন সার্চ দরকার
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: getHistory(chatId),
    });

    // response এ টেক্সট আর সার্চ রেজাল্ট মিশ্রিত থাকতে পারে, শুধু টেক্সট অংশ জোড়া দিচ্ছি
    const replyText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim() || "দুঃখিত, উত্তর তৈরি করতে পারিনি।";

    pushHistory(chatId, "assistant", replyText);

    // টেলিগ্রামের মেসেজ লিমিট ৪০৯৬ ক্যারেক্টার, বড় উত্তর হলে ভাগ করে পাঠাচ্ছে
    for (let i = 0; i < replyText.length; i += 4000) {
      await ctx.reply(replyText.slice(i, i + 4000));
    }
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ একটি এরর হয়েছে। API key বা ব্যালেন্স চেক করুন।");
  }
});

// ==== ছবি হ্যান্ডলার ====
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  try {
    await ctx.replyWithChatAction("typing");

    // সবচেয়ে বড় সাইজের ছবিটা নেওয়া হচ্ছে
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const file = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // ছবি ডাউনলোড করে base64 এ কনভার্ট
    const imgResponse = await fetch(fileUrl);
    const arrayBuffer = await imgResponse.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString("base64");
    const mediaType = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";

    const caption = ctx.message.caption || "এই ছবিতে কী আছে বলো।";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
            { type: "text", text: caption },
          ],
        },
      ],
    });

    const replyText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    await ctx.reply(replyText || "ছবিটি বুঝতে পারিনি।");
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ ছবি প্রসেস করতে সমস্যা হয়েছে।");
  }
});

// ==== ডকুমেন্ট/ফাইল হ্যান্ডলার (PDF ইত্যাদি) ====
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (doc.mime_type !== "application/pdf") {
    await ctx.reply("⚠️ আপাতত শুধু PDF ফাইল সাপোর্ট করি।");
    return;
  }
  try {
    await ctx.replyWithChatAction("typing");
    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const pdfResponse = await fetch(fileUrl);
    const arrayBuffer = await pdfResponse.arrayBuffer();
    const base64Pdf = Buffer.from(arrayBuffer).toString("base64");

    const caption = ctx.message.caption || "এই ডকুমেন্টটি সংক্ষেপে বলো।";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Pdf } },
            { type: "text", text: caption },
          ],
        },
      ],
    });

    const replyText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    await ctx.reply(replyText || "ফাইলটি বুঝতে পারিনি।");
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ ফাইল প্রসেস করতে সমস্যা হয়েছে।");
  }
});

bot.start();
console.log("🤖 Telegram Bot চলছে...");
