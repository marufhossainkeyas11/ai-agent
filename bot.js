const { Bot, InputFile } = require("grammy");
const Anthropic = require("@anthropic-ai/sdk");
const http = require("http");
require("dotenv").config();

// ==== এখানে দুটো জিনিস বসান (নিচে .env ফাইলেও করা যায়, ওটাই ভালো) ====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// ElevenLabs (ঐচ্ছিক) — না থাকলে ভয়েস ফিচার বন্ধ থাকবে, বাকি বট আগের মতোই চলবে
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_v3"; // বাংলা সাপোর্ট করে
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
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

// ==== ElevenLabs: টেক্সট → ভয়েস ====
async function textToSpeech(text) {
  const clean = text.replace(/[*_`#>~]/g, "").slice(0, 4500); // মার্কডাউন চিহ্ন বাদ + লিমিট
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_64`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean, model_id: ELEVENLABS_TTS_MODEL }),
    }
  );
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ==== ElevenLabs: ভয়েস → টেক্সট ====
async function speechToText(audioBuffer) {
  const form = new FormData();
  form.append("model_id", ELEVENLABS_STT_MODEL);
  form.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.text || "").trim();
}

// যে চ্যাটে /voice চালু আছে, সেখানে টেক্সট প্রশ্নের উত্তরও ভয়েসে আসবে (রিস্টার্টে রিসেট)
const voiceChats = new Set();

// ==== Claude কে প্রশ্ন করা (টেক্সট ও ভয়েস দুই হ্যান্ডলারই এটা ব্যবহার করে) ====
async function askClaude(chatId, userText) {
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
  return replyText;
}

// ==== উত্তর পাঠানো: টেক্সট (সবসময়) + ভয়েস (withVoice হলে) ====
async function sendReply(ctx, replyText, withVoice) {
  // টেলিগ্রামের মেসেজ লিমিট ৪০৯৬ ক্যারেক্টার, বড় উত্তর হলে ভাগ করে পাঠাচ্ছে
  for (let i = 0; i < replyText.length; i += 4000) {
    await ctx.reply(replyText.slice(i, i + 4000));
  }
  if (!withVoice || !ELEVENLABS_API_KEY) return;
  try {
    await ctx.replyWithChatAction("record_voice");
    const audio = await textToSpeech(replyText);
    await ctx.replyWithVoice(new InputFile(audio, "reply.mp3"));
  } catch (error) {
    console.error("ElevenLabs TTS error:", error.message);
    await ctx.reply("⚠️ ভয়েস তৈরি করা যায়নি (ElevenLabs key বা ক্রেডিট চেক করুন)।");
  }
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
  if (userText === "/voice") {
    if (!ELEVENLABS_API_KEY) {
      await ctx.reply("⚠️ ELEVENLABS_API_KEY সেট করা নেই।");
      return;
    }
    const on = !voiceChats.has(chatId);
    if (on) voiceChats.add(chatId);
    else voiceChats.delete(chatId);
    await ctx.reply(on ? "🔊 ভয়েস উত্তর চালু।" : "🔇 ভয়েস উত্তর বন্ধ।");
    return;
  }
  if (userText === "/start") {
    await ctx.reply("👋 হ্যালো! আমি Claude AI বট। টেক্সট লিখুন, ছবি পাঠান, বা প্রশ্ন করুন — যা খুশি জিজ্ঞেস করতে পারেন।\n\nমেমরি মুছতে: /clear\nভয়েস উত্তর চালু/বন্ধ: /voice\n🎤 ভয়েস মেসেজও পাঠাতে পারেন।");
    return;
  }

  try {
    await ctx.replyWithChatAction("typing");
    const replyText = await askClaude(chatId, userText);
    await sendReply(ctx, replyText, voiceChats.has(chatId));
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ একটি এরর হয়েছে। API key বা ব্যালেন্স চেক করুন।");
  }
});

// ==== ভয়েস মেসেজ হ্যান্ডলার (ElevenLabs STT → Claude → টেক্সট + ভয়েস উত্তর) ====
bot.on("message:voice", async (ctx) => {
  const chatId = ctx.chat.id;
  if (!ELEVENLABS_API_KEY) {
    await ctx.reply("⚠️ ভয়েসের জন্য ELEVENLABS_API_KEY সেট করুন।");
    return;
  }
  try {
    await ctx.replyWithChatAction("typing");
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const audioBuffer = Buffer.from(await (await fetch(fileUrl)).arrayBuffer());

    const userText = await speechToText(audioBuffer);
    if (!userText) {
      await ctx.reply("⚠️ ভয়েস থেকে কিছু বুঝতে পারিনি।");
      return;
    }
    await ctx.reply(`🎤 ${userText}`);

    const replyText = await askClaude(chatId, userText);
    await sendReply(ctx, replyText, true);
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ ভয়েস প্রসেস করতে সমস্যা হয়েছে।");
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
