# Telegram Claude Bot — সেটআপ গাইড

এই বট টেক্সট চ্যাট, ছবি বোঝা, PDF পড়া, মেমরি রাখা এবং ওয়েব সার্চ — সব করতে পারে।

## ধাপ ১ — নতুন Telegram বট বানান
1. Telegram এ `@BotFather` কে মেসেজ দিন
2. `/newbot` পাঠান, নাম ও ইউজারনেম দিন (ইউজারনেম `bot` দিয়ে শেষ হতে হবে)
3. যে টোকেন পাবেন সেটা কপি করে রাখুন

## ধাপ ২ — নতুন Anthropic API key বানান
⚠️ আগে যে key গুলো চ্যাটে শেয়ার হয়েছিল সেগুলো **revoke করে দিন**:
https://console.anthropic.com/settings/keys — সেখান থেকে delete করুন, তারপর নতুন একটা "Create Key" করুন।

## ধাপ ৩ — কোড রেডি করুন
এই ফোল্ডারের সব ফাইল (`bot.js`, `package.json`, `.gitignore`, `.env.example`) নিজের কম্পিউটারে বা সরাসরি GitHub রিপোতে রাখুন।

`.env.example` ফাইলের নাম পরিবর্তন করে `.env` করুন, এবং ভেতরে দুটো জায়গায় আসল টোকেন বসান:
```
TELEGRAM_BOT_TOKEN=আপনার_টেলিগ্রাম_টোকেন
ANTHROPIC_API_KEY=আপনার_নতুন_anthropic_key
```

## ধাপ ৪ — Render এ ফ্রি হোস্ট করুন (সবচেয়ে কম ঝামেলা)
1. https://render.com এ GitHub দিয়ে সাইন আপ করুন
2. কোডটা একটা GitHub রিপোতে পুশ করুন (`.env` ফাইল **push করবেন না** — `.gitignore` এ আগে থেকেই বাদ দেওয়া আছে)
3. Render ড্যাশবোর্ডে "New +" → "Background Worker" সিলেক্ট করুন (Web Service না — এটা কোনো HTTP পোর্ট খোলে না, তাই Background Worker ঠিক)
4. আপনার GitHub রিপো কানেক্ট করুন
5. Build Command: `npm install`
6. Start Command: `npm start`
7. "Environment" ট্যাবে গিয়ে Environment Variables যোগ করুন:
   - `TELEGRAM_BOT_TOKEN` → আপনার টোকেন
   - `ANTHROPIC_API_KEY` → আপনার নতুন key
8. Deploy করুন — কয়েক মিনিটে বট চালু হয়ে যাবে

## ধাপ ৫ — টেস্ট করুন
Telegram এ আপনার বটকে `/start` পাঠান। তারপর যেকোনো প্রশ্ন, ছবি, বা PDF পাঠিয়ে দেখুন।

## নিজের কম্পিউটারে টেস্ট করতে চাইলে (Render এ দেওয়ার আগে)
```bash
npm install
npm start
```

## গুরুত্বপূর্ণ নোট
- **মেমরি স্থায়ী নয়** — বট রিস্টার্ট হলে সব চ্যাট হিস্ট্রি মুছে যাবে। স্থায়ী মেমরি (ফাইল/ডেটাবেসে সেভ) দরকার হলে জানাবেন, কোড আপডেট করে দেব।
- **`/clear`** কমান্ড দিয়ে ব্যবহারকারী নিজেই মেমরি রিসেট করতে পারবে।
- বট চালু রাখতে Render এর ফ্রি প্ল্যানে **Background Worker** ব্যবহার করা জরুরি (Web Service ব্যবহার করলে idle এ বন্ধ হয়ে যেতে পারে)।
- আপনার API key **কখনো** কোনো চ্যাটে বা পাবলিক জায়গায় (GitHub সহ) পেস্ট করবেন না — শুধু Render এর Environment Variables এ রাখুন।
