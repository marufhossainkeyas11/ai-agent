const { Bot, InputFile } = require("grammy");
const http = require("http");
require("dotenv").config();

// ==== এখানে দুটো জিনিস বসান (নিচে .env ফাইলেও করা যায়, ওটাই ভালো) ====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// AI (যেকোনো OpenAI-compatible API: Gemini, Groq, OpenRouter, OpenAI ইত্যাদি)
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL;
// শুধু এই Telegram ID কাজ করাতে পারবে (নিচে দেখুন)
const OWNER_ID = (process.env.OWNER_ID || "").trim();
// ElevenLabs (ঐচ্ছিক) — না থাকলে ভয়েস ফিচার বন্ধ থাকবে, বাকি বট আগের মতোই চলবে
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_v3"; // বাংলা সাপোর্ট করে
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; // Render নিজে থেকেই এটা সেট করে দেয়

const missing = [];
if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
if (!LLM_API_KEY) missing.push("LLM_API_KEY");
if (!LLM_BASE_URL) missing.push("LLM_BASE_URL");
if (!LLM_MODEL) missing.push("LLM_MODEL");
if (missing.length) {
  console.error(`❌ এই Environment Variable পাওয়া যায়নি: ${missing.join(", ")}`);
  // শুধু নাম দেখাচ্ছে (মান নয়), যাতে বানান ভুল ধরা যায়
  const seen = Object.keys(process.env).filter((k) => /TELEGRAM|LLM|OWNER|ELEVEN|TOKEN|KEY/i.test(k));
  console.error("ℹ️ এখন সেট করা সম্ভাব্য নাম:", seen.length ? seen.join(", ") : "(কিছুই নেই)");
  console.error("ℹ️ নাম হুবহু মিলতে হবে — বড় হাতের অক্ষর, কোনো স্পেস নেই।");
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

// ==== শুধু মালিক ব্যবহার করতে পারবে ====
// OWNER_ID সেট না থাকলে শুধু /id কাজ করবে (নিজের ID জানার জন্য), বাকি সব বন্ধ।
// OWNER_ID সেট থাকলে অন্য কেউ মেসেজ দিলে বট কোনো উত্তরই দেবে না।
if (!OWNER_ID) console.warn("⚠️ OWNER_ID সেট নেই — বটকে /id পাঠিয়ে আপনার ID নিন, তারপর OWNER_ID সেট করুন।");
bot.use(async (ctx, next) => {
  const fromId = ctx.from ? String(ctx.from.id) : "";
  if (!OWNER_ID) {
    if (ctx.message && ctx.message.text === "/id") {
      await ctx.reply(`আপনার Telegram ID: ${fromId}\nএটা Render এ OWNER_ID হিসেবে সেট করুন।`);
    }
    return;
  }
  if (fromId !== OWNER_ID) return;
  await next();
});

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

// ==== AI কে প্রশ্ন করা (OpenAI-compatible /chat/completions) ====
const SYSTEM_PROMPT =
  "তুমি একজন সহায়ক AI সহকারী। ব্যবহারকারী যে ভাষায় লেখে (বাংলা বা ইংরেজি) সেই ভাষায় সংক্ষেপে ও পরিষ্কারভাবে উত্তর দাও।";

async function callLLM(messages) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LLM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: LLM_MODEL, messages }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return ((data.choices && data.choices[0] && data.choices[0].message.content) || "").trim();
}

// টেক্সট ও ভয়েস দুই হ্যান্ডলারই এটা ব্যবহার করে
async function askAI(chatId, userText) {
  pushHistory(chatId, "user", userText);
  const replyText =
    (await callLLM([{ role: "system", content: SYSTEM_PROMPT }, ...getHistory(chatId)])) ||
    "দুঃখিত, উত্তর তৈরি করতে পারিনি।";
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
    await ctx.reply("👋 হ্যালো! আমি AI বট। টেক্সট লিখুন, ছবি পাঠান, বা প্রশ্ন করুন — যা খুশি জিজ্ঞেস করতে পারেন।\n\nমেমরি মুছতে: /clear\nভয়েস উত্তর চালু/বন্ধ: /voice\n🎤 ভয়েস মেসেজও পাঠাতে পারেন।");
    return;
  }

  try {
    await ctx.replyWithChatAction("typing");
    const replyText = await askAI(chatId, userText);
    await sendReply(ctx, replyText, voiceChats.has(chatId));
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ একটি এরর হয়েছে। AI API key, মডেলের নাম বা লিমিট চেক করুন।");
  }
});

// ==== ভয়েস মেসেজ হ্যান্ডলার (ElevenLabs STT → AI → টেক্সট + ভয়েস উত্তর) ====
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

    const replyText = await askAI(chatId, userText);
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

    const replyText = await callLLM([
      {
        role: "user",
        content: [
          { type: "text", text: caption },
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64Image}` } },
        ],
      },
    ]);

    await ctx.reply(replyText || "ছবিটি বুঝতে পারিনি।");
  } catch (error) {
    console.error(error);
    await ctx.reply("⚠️ ছবি প্রসেস করতে সমস্যা হয়েছে।");
  }
});

// ==== ডকুমেন্ট/ফাইল (PDF পড়া এই ভার্সনে নেই) ====
bot.on("message:document", async (ctx) => {
  await ctx.reply("⚠️ আপাতত ফাইল/PDF সাপোর্ট নেই। টেক্সট, ছবি বা ভয়েস পাঠান।");
});

bot.start();
console.log("🤖 Telegram Bot চলছে...");
