// server.js — سيرفر الويب هوك اللي هيستقبل رسايل واتساب ويرد عليها
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { generateReply } = require('./agentBrain');

const app = express();
app.use(express.json());

// ===== إعدادات لازم تحطها في ملف .env (شوف .env.example) =====
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ذاكرة محادثات بسيطة لكل عميل (في الإنتاج الأفضل تتحط في قاعدة بيانات
// عشان متضيعش المحادثة لو السيرفر أعاد التشغيل)
const conversations = new Map();

// ----- 1) التحقق من الويب هوك (ميتا بتطلبه مرة واحدة وقت الربط) -----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ تم التحقق من الويب هوك بنجاح');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ----- 2) استقبال الرسايل الجديدة من العملاء -----
app.post('/webhook', async (req, res) => {
  // نرد على ميتا فورًا (خلال 20 ثانية) قبل أي معالجة، والمعالجة تكمل في الخلفية
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message || message.type !== 'text') return; // نتجاهل غير رسايل النصوص دلوقتي

    const from = message.from; // رقم العميل
    const text = message.text.body;

    console.log(`📩 رسالة من ${from}: ${text}`);

    const history = conversations.get(from) || [];
    const reply = await generateReply(history, text);

    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    conversations.set(from, history.slice(-20)); // نحتفظ بآخر 20 رسالة بس

    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error('❌ خطأ في معالجة الرسالة:', err.message);
  }
});

async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

app.get('/', (req, res) => res.send('Sadin AI Agent — شغال ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 السيرفر شغال على بورت ${PORT}`));
