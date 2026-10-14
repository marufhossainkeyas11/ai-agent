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
// ElevenLabs (মূল ফিচার)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_v3"; // বাংলা সাপোর্ট করে
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL; // Render নিজে থেকেই এটা সেট করে দেয়

const missing = [];
if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
if (!ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");
if (missing.length) {
  console.error(`❌ এই Environment Variable পাওয়া যায়নি: ${missing.join(", ")}`);
  // শুধু নাম দেখাচ্ছে (মান নয়), যাতে বানান ভুল ধরা যায়
  const seen = Object.keys(process.env).filter((k) => /TELEGRAM|LLM|OWNER|ELEVEN|TOKEN|KEY/i.test(k));
  console.error("ℹ️ এখন সেট করা সম্ভাব্য নাম:", seen.length ? seen.join(", ") : "(কিছুই নেই)");
  console.error("ℹ️ নাম হুবহু মিলতে হবে — বড় হাতের অক্ষর, কোনো স্পেস নেই।");
  process.exit(1);
}

// AI (LLM_*) ঐচ্ছিক — না থাকলে বট শুধু ElevenLabs দিয়ে চলবে (লিখলে পড়ে শোনাবে, ভয়েস দিলে লিখে দেবে)
const LLM_ENABLED = Boolean(LLM_API_KEY && LLM_BASE_URL && LLM_MODEL);
console.log(LLM_ENABLED ? `🧠 AI চালু (${LLM_MODEL})` : "🧠 AI বন্ধ — শুধু ElevenLabs মোড");

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
async function textToSpeech(text, voiceId = ELEVENLABS_VOICE_ID) {
  const clean = text.replace(/[*_`#>~]/g, "").slice(0, 4500); // মার্কডাউন চিহ্ন বাদ + লিমিট
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
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


// ==== সাধারণ ElevenLabs অডিও কল (SFX, মিউজিক, ভয়েস চেঞ্জার, নয়েজ রিমুভ) ====
async function elevenAudio(path, { json, form } = {}) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY, ...(json ? { "Content-Type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : form,
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function elevenJson(path) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, { headers: { "xi-api-key": ELEVENLABS_API_KEY } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// প্রতি চ্যাটের জন্য আলাদা ভয়েস (/setvoice) — রিস্টার্টে ডিফল্টে ফিরবে
const chatVoices = new Map();
const voiceFor = (chatId) => chatVoices.get(chatId) || ELEVENLABS_VOICE_ID;

async function downloadTelegramFile(ctx, fileId) {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

// ভয়েস হিসেবে পাঠায়; Telegram না নিলে (প্রাইভেসি সেটিং) অডিও ফাইল হিসেবে পাঠায়
async function sendVoice(ctx, buf, name = "voice.mp3") {
  try {
    await ctx.replyWithVoice(new InputFile(buf, name));
  } catch (e) {
    await ctx.replyWithAudio(new InputFile(buf, name));
  }
}

async function replyLong(ctx, text) {
  for (let i = 0; i < text.length; i += 4000) await ctx.reply(text.slice(i, i + 4000));
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
  let replyText;
  try {
    replyText =
      (await callLLM([{ role: "system", content: SYSTEM_PROMPT }, ...getHistory(chatId)])) ||
      "দুঃখিত, উত্তর তৈরি করতে পারিনি।";
  } catch (e) {
    getHistory(chatId).pop(); // ব্যর্থ প্রশ্ন হিস্ট্রিতে রাখছি না
    throw e;
  }
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
    const audio = await textToSpeech(replyText, voiceFor(ctx.chat.id));
    await sendVoice(ctx, audio, "reply.mp3");
  } catch (error) {
    console.error("ElevenLabs TTS error:", error.message);
    await ctx.reply(`⚠️ ভয়েস তৈরি করা যায়নি: ${String(error.message).slice(0, 300)}`);
  }
}

// ==== ElevenLabs কমান্ড ====
const safe = (label, fn) => async (ctx) => {
  try {
    await fn(ctx);
  } catch (error) {
    console.error(label, error);
    await ctx.reply(`⚠️ ${label} ব্যর্থ: ${String(error.message).slice(0, 400)}`);
  }
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const argText = (ctx) => (ctx.match || "").trim();
// "/cmd 20 টেক্সট" → { num: 20, rest: "টেক্সট" }
function splitNumber(text) {
  const m = text.match(/^(\d+(?:\.\d+)?)\s+([\s\S]+)$/);
  return m ? { num: parseFloat(m[1]), rest: m[2] } : { num: null, rest: text };
}
function repliedAudioId(ctx) {
  const r = ctx.message.reply_to_message;
  const a = r && (r.voice || r.audio);
  return a ? a.file_id : null;
}

// /say <লেখা> — যেকোনো লেখা পড়ে শোনাবে (লেখায় রিপ্লাই করেও চলে)
bot.command("say", safe("TTS", async (ctx) => {
  const r = ctx.message.reply_to_message;
  const text = argText(ctx) || (r && (r.text || r.caption)) || "";
  if (!text) return ctx.reply("ব্যবহার: /say আপনার লেখা");
  await ctx.replyWithChatAction("record_voice");
  await sendVoice(ctx, await textToSpeech(text, voiceFor(ctx.chat.id)), "say.mp3");
}));

// /sfx [সেকেন্ড] <বর্ণনা> — সাউন্ড ইফেক্ট (০.৫–৩০ সেকেন্ড)
bot.command("sfx", safe("সাউন্ড ইফেক্ট", async (ctx) => {
  const { num, rest } = splitNumber(argText(ctx));
  if (!rest) return ctx.reply("ব্যবহার: /sfx 5 বজ্রপাতের শব্দ  (সেকেন্ড না দিলে অটো)");
  await ctx.replyWithChatAction("upload_voice");
  const json = { text: rest };
  if (num) json.duration_seconds = clamp(num, 0.5, 30);
  await ctx.replyWithAudio(new InputFile(await elevenAudio("/v1/sound-generation", { json }), "sfx.mp3"));
}));

// /music [সেকেন্ড] <বর্ণনা> — মিউজিক (ডিফল্ট ৩০ সেকেন্ড, সর্বোচ্চ ১০ মিনিট; ক্রেডিট বেশি লাগে)
bot.command("music", safe("মিউজিক", async (ctx) => {
  const { num, rest } = splitNumber(argText(ctx));
  if (!rest) return ctx.reply("ব্যবহার: /music 30 শান্ত lo-fi বিট  (সেকেন্ড না দিলে ৩০)");
  await ctx.reply("🎵 বানাচ্ছি, একটু সময় লাগবে...");
  await ctx.replyWithChatAction("upload_voice");
  const json = { prompt: rest, music_length_ms: Math.round(clamp(num || 30, 3, 600) * 1000) };
  await ctx.replyWithAudio(new InputFile(await elevenAudio("/v1/music", { json }), "music.mp3"));
}));

// /voices — আপনার অ্যাকাউন্টের ভয়েস লিস্ট
bot.command("voices", safe("ভয়েস লিস্ট", async (ctx) => {
  let data;
  try {
    data = await elevenJson("/v2/voices?page_size=100");
  } catch (e) {
    data = await elevenJson("/v1/voices");
  }
  const lines = (data.voices || []).map((v) => `${v.name} — ${v.voice_id}`);
  if (!lines.length) return ctx.reply("কোনো ভয়েস পাওয়া যায়নি।");
  await replyLong(ctx, `${lines.join("\n")}\n\nবদলাতে: /setvoice <voice_id>`);
}));

// /setvoice <voice_id> — এই চ্যাটের ভয়েস বদলায় (/setvoice reset = ডিফল্ট)
bot.command("setvoice", safe("ভয়েস বদল", async (ctx) => {
  const id = argText(ctx);
  if (!id) return ctx.reply("ব্যবহার: /setvoice <voice_id>   (আইডি দেখতে /voices)");
  if (id === "reset") {
    chatVoices.delete(ctx.chat.id);
    return ctx.reply("✅ ডিফল্ট ভয়েসে ফিরেছে।");
  }
  const v = await elevenJson(`/v1/voices/${encodeURIComponent(id)}`);
  chatVoices.set(ctx.chat.id, id);
  await ctx.reply(`✅ ভয়েস: ${v.name || id}`);
}));

// /change — কোনো ভয়েস মেসেজে রিপ্লাই করে দিন; একই কথা বর্তমান ভয়েসে ফেরত আসবে (Voice Changer)
bot.command("change", safe("ভয়েস চেঞ্জার", async (ctx) => {
  const fileId = repliedAudioId(ctx);
  if (!fileId) return ctx.reply("কোনো ভয়েস/অডিও মেসেজে রিপ্লাই করে /change লিখুন।");
  await ctx.replyWithChatAction("record_voice");
  const form = new FormData();
  form.append("model_id", "eleven_multilingual_sts_v2");
  form.append("audio", new Blob([await downloadTelegramFile(ctx, fileId)], { type: "audio/ogg" }), "input.ogg");
  await sendVoice(ctx, await elevenAudio(`/v1/speech-to-speech/${voiceFor(ctx.chat.id)}?output_format=mp3_44100_64`, { form }), "changed.mp3");
}));

// /clean — কোনো ভয়েস/অডিওতে রিপ্লাই করে দিন; ব্যাকগ্রাউন্ড নয়েজ মুছে পরিষ্কার কণ্ঠ ফেরত দেবে (Voice Isolator)
bot.command("clean", safe("নয়েজ রিমুভ", async (ctx) => {
  const fileId = repliedAudioId(ctx);
  if (!fileId) return ctx.reply("কোনো ভয়েস/অডিও মেসেজে রিপ্লাই করে /clean লিখুন।");
  await ctx.replyWithChatAction("upload_voice");
  const form = new FormData();
  form.append("audio", new Blob([await downloadTelegramFile(ctx, fileId)], { type: "audio/ogg" }), "input.ogg");
  await ctx.replyWithAudio(new InputFile(await elevenAudio("/v1/audio-isolation", { form }), "clean.mp3"));
}));

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
    await ctx.reply(
      "👋 হ্যালো! আমি ElevenLabs ভয়েস বট।\n\n" +
        (LLM_ENABLED
          ? "💬 লিখুন/ছবি পাঠান — AI উত্তর দেবে (/voice দিলে ভয়েসেও)\n"
          : "💬 কিছু লিখলে আমি পড়ে শোনাব\n") +
        "🎤 ভয়েস মেসেজ পাঠান — লিখে দেব\n\n" +
        "/say লেখা — পড়ে শোনাব\n/sfx 5 বজ্রপাত — সাউন্ড ইফেক্ট\n/music 30 lo-fi বিট — মিউজিক\n" +
        "/voices, /setvoice — ভয়েস বদল\n/change (ভয়েসে রিপ্লাই) — কণ্ঠ বদল\n/clean (ভয়েসে রিপ্লাই) — নয়েজ মুছুন\n/clear — মেমরি মুছুন"
    );
    return;
  }

  // AI না থাকলে সাধারণ লেখা পড়ে শোনানো হবে
  if (!LLM_ENABLED) {
    try {
      await ctx.replyWithChatAction("record_voice");
      await sendVoice(ctx, await textToSpeech(userText, voiceFor(chatId)), "say.mp3");
    } catch (error) {
      console.error(error);
      await ctx.reply(`⚠️ ভয়েস তৈরি করা যায়নি: ${String(error.message).slice(0, 300)}`);
    }
    return;
  }

  try {
    await ctx.replyWithChatAction("typing");
    const replyText = await askAI(chatId, userText);
    await sendReply(ctx, replyText, voiceChats.has(chatId));
  } catch (error) {
    console.error(error);
    await ctx.reply(`⚠️ AI এরর: ${String(error.message).slice(0, 400)}`);
  }
});

// ==== ভয়েস/অডিও হ্যান্ডলার: ElevenLabs STT → লেখা; AI চালু থাকলে AI উত্তর (টেক্সট + ভয়েস) ====
async function handleAudioIn(ctx, fileId, withAI) {
  const chatId = ctx.chat.id;
  await ctx.replyWithChatAction("typing");
  const userText = await speechToText(await downloadTelegramFile(ctx, fileId));
  if (!userText) {
    await ctx.reply("⚠️ অডিও থেকে কিছু বুঝতে পারিনি।");
    return;
  }
  await replyLong(ctx, `🎤 ${userText}`);
  if (!withAI || !LLM_ENABLED) return;

  try {
    const replyText = await askAI(chatId, userText);
    await sendReply(ctx, replyText, true);
  } catch (error) {
    console.error(error);
    await ctx.reply(`⚠️ AI এরর: ${String(error.message).slice(0, 400)}`);
  }
}

bot.on("message:voice", async (ctx) => {
  try {
    await handleAudioIn(ctx, ctx.message.voice.file_id, true);
  } catch (error) {
    console.error(error);
    await ctx.reply(`⚠️ ভয়েস প্রসেস ব্যর্থ: ${String(error.message).slice(0, 300)}`);
  }
});

// অডিও ফাইল (MP3 ইত্যাদি) পাঠালে শুধু লিখে দেবে (AI ছাড়া)
bot.on("message:audio", async (ctx) => {
  try {
    await handleAudioIn(ctx, ctx.message.audio.file_id, false);
  } catch (error) {
    console.error(error);
    await ctx.reply(`⚠️ অডিও প্রসেস ব্যর্থ: ${String(error.message).slice(0, 300)}`);
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

// Telegram এর "/" মেনুতে কমান্ড দেখানো
bot.api
  .setMyCommands([
    { command: "say", description: "লেখা পড়ে শোনাও" },
    { command: "sfx", description: "সাউন্ড ইফেক্ট বানাও" },
    { command: "music", description: "মিউজিক বানাও" },
    { command: "voices", description: "ভয়েসের লিস্ট" },
    { command: "setvoice", description: "ভয়েস বদলাও" },
    { command: "change", description: "ভয়েসে রিপ্লাই করে কণ্ঠ বদলাও" },
    { command: "clean", description: "ভয়েসে রিপ্লাই করে নয়েজ মুছো" },
    { command: "voice", description: "AI উত্তর ভয়েসে চালু/বন্ধ" },
    { command: "clear", description: "মেমরি মুছো" },
  ])
  .catch(() => {});

bot.start();
console.log("🤖 Telegram Bot চলছে...");
