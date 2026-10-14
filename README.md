# Telegram AI Bot — শুধু মালিকের জন্য

টেক্সট চ্যাট, ছবি বোঝা, আর ElevenLabs ভয়েস (ভয়েস মেসেজ → টেক্সট, উত্তর → ভয়েস)।
Anthropic লাগে না — যেকোনো OpenAI-compatible AI API চলে।

> বাদ গেছে: ওয়েব সার্চ ও PDF পড়া (এগুলো Anthropic-নির্ভর ছিল)।

## ১. Environment Variables (Render → Environment)
| নাম | কী বসাবেন |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather থেকে পাওয়া টোকেন |
| `LLM_API_KEY` | আপনার AI provider এর key |
| `LLM_BASE_URL` | provider এর base URL (নিচে উদাহরণ) |
| `LLM_MODEL` | provider এর মডেলের হুবহু নাম |
| `ELEVENLABS_API_KEY` | ElevenLabs key (ঐচ্ছিক — না দিলে ভয়েস বন্ধ) |
| `OWNER_ID` | আপনার Telegram numeric ID (নিচে দেখুন) |

`LLM_BASE_URL` উদাহরণ:
- Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`
- Groq: `https://api.groq.com/openai/v1`
- OpenRouter: `https://openrouter.ai/api/v1`
- OpenAI: `https://api.openai.com/v1`

ছবি বোঝার জন্য এমন মডেল লাগবে যেটা image সাপোর্ট করে।

## ২. মালিক ঠিক করা (OWNER_ID)
1. `OWNER_ID` ছাড়াই প্রথমে deploy করুন
2. বটকে Telegram এ `/id` পাঠান — আপনার ID বলে দেবে
3. Render এ `OWNER_ID` = সেই সংখ্যা সেট করুন, redeploy করুন
4. এরপর থেকে শুধু আপনার মেসেজেই বট উত্তর দেবে; অন্য কেউ লিখলে কোনো সাড়া পাবে না

## ৩. কমান্ড
- `/start` — পরিচয়
- `/clear` — মেমরি মুছুন
- `/voice` — টেক্সট প্রশ্নের উত্তরও ভয়েসে পেতে চালু/বন্ধ
- 🎤 ভয়েস মেসেজ পাঠালে উত্তর টেক্সট + ভয়েস দুটোই আসে

## ৪. Render এ চালানো
Build: `npm install` · Start: `npm start`

## নোট
- মেমরি স্থায়ী নয় — বট রিস্টার্ট হলে হিস্ট্রি ও `/voice` সেটিং মুছে যায়
- কোনো key GitHub বা চ্যাটে পেস্ট করবেন না — শুধু Render এর Environment Variables এ
