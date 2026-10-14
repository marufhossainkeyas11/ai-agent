# Telegram ElevenLabs বট — শুধু মালিকের জন্য

ElevenLabs এর ভয়েস ফিচার Telegram এ। AI চ্যাট ঐচ্ছিক (Anthropic লাগে না)।

## Environment Variables (Render → Environment)
| নাম | |
|---|---|
| `TELEGRAM_BOT_TOKEN` | বাধ্যতামূলক — @BotFather থেকে |
| `ELEVENLABS_API_KEY` | বাধ্যতামূলক |
| `OWNER_ID` | আপনার Telegram ID (বটকে `/id` পাঠিয়ে জানুন) — না দিলে শুধু `/id` কাজ করবে |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | ঐচ্ছিক — যেকোনো OpenAI-compatible AI (Gemini, Groq, OpenRouter…)। না দিলে AI বন্ধ |
| `ELEVENLABS_VOICE_ID` / `ELEVENLABS_TTS_MODEL` / `ELEVENLABS_STT_MODEL` | ঐচ্ছিক (ডিফল্ট: George / `eleven_v3` / `scribe_v1`) |

## ফিচার
| কী পাঠাবেন | কী হবে |
|---|---|
| 🎤 ভয়েস মেসেজ / অডিও ফাইল | লিখে দেবে (Speech-to-Text); AI চালু থাকলে AI উত্তরও দেবে |
| যেকোনো লেখা (AI বন্ধ থাকলে) | পড়ে শোনাবে (Text-to-Speech) |
| `/say লেখা` | পড়ে শোনাবে (লেখায় রিপ্লাই করেও চলে) |
| `/sfx 5 বজ্রপাত` | সাউন্ড ইফেক্ট (০.৫–৩০ সেকেন্ড; সেকেন্ড না দিলে অটো) |
| `/music 30 শান্ত lo-fi বিট` | মিউজিক (ডিফল্ট ৩০ সেকেন্ড, সর্বোচ্চ ১০ মিনিট — ক্রেডিট বেশি লাগে) |
| `/voices` | আপনার অ্যাকাউন্টের ভয়েস লিস্ট |
| `/setvoice <voice_id>` | ভয়েস বদলান (`/setvoice reset` = ডিফল্ট) |
| ভয়েসে রিপ্লাই করে `/change` | একই কথা বর্তমান ভয়েসে (Voice Changer) |
| ভয়েসে রিপ্লাই করে `/clean` | ব্যাকগ্রাউন্ড নয়েজ মুছবে (Voice Isolator) |
| `/voice` | (AI চালু থাকলে) AI উত্তর ভয়েসেও পাওয়া চালু/বন্ধ |
| `/clear` | AI চ্যাটের মেমরি মুছুন |

ছবি পাঠালে (AI চালু থাকলে) ছবি বুঝে উত্তর দেবে। PDF ও ওয়েব সার্চ নেই।

## Render এ চালানো
Build: `npm install` · Start: `npm start`

## নোট
- মেমরি, `/voice` ও `/setvoice` সেটিং স্থায়ী নয় — রিস্টার্টে ডিফল্টে ফেরে
- কোনো key GitHub বা চ্যাটে পেস্ট করবেন না — শুধু Render এর Environment Variables এ
- ElevenLabs key এ যত কম পারমিশন দেবেন তত নিরাপদ; ব্যবহৃত ফিচারের জন্য লাগে: Text to Speech, Speech to Text, Sound Effects, Music, Voice Changer, Audio Isolation, Voices (read)
