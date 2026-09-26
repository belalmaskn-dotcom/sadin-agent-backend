// server.js — Sadin AI Agent WhatsApp Webhook

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const { generateReply } = require('./agentBrain');

const app = express();
app.use(express.json());


// =====================================================
// Environment Variables
// =====================================================

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;


// =====================================================
// PostgreSQL
// =====================================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});


// =====================================================
// إنشاء الجداول تلقائيًا
// =====================================================

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id BIGSERIAL PRIMARY KEY,
        customer_phone VARCHAR(30) NOT NULL,
        role VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        whatsapp_message_id VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_customer_phone
      ON conversations(customer_phone);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_created_at
      ON conversations(created_at);
    `);

    console.log('✅ قاعدة بيانات العملاء جاهزة');
  } catch (err) {
    console.error(
      '❌ خطأ في تجهيز قاعدة البيانات:',
      err.message
    );
  }
}


// =====================================================
// حفظ رسالة في قاعدة البيانات
// =====================================================

async function saveMessage({
  customerPhone,
  role,
  message,
  whatsappMessageId = null,
}) {
  try {
    await pool.query(
      `
      INSERT INTO conversations
      (
        customer_phone,
        role,
        message,
        whatsapp_message_id
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        customerPhone,
        role,
        message,
        whatsappMessageId,
      ]
    );
  } catch (err) {
    console.error(
      '❌ فشل حفظ الرسالة في قاعدة البيانات:',
      err.message
    );
  }
}


// =====================================================
// تحميل آخر المحادثة من PostgreSQL
// بدل الاعتماد على ذاكرة Render
// =====================================================

async function getConversationHistory(customerPhone) {
  try {
    const result = await pool.query(
      `
      SELECT role, message
      FROM conversations
      WHERE customer_phone = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 20
      `,
      [customerPhone]
    );

    return result.rows
      .reverse()
      .map((row) => ({
        role: row.role,
        content: row.message,
      }));

  } catch (err) {
    console.error(
      '❌ فشل تحميل المحادثة:',
      err.message
    );

    return [];
  }
}


// =====================================================
// منع معالجة نفس رسالة واتساب مرتين
// =====================================================

async function messageAlreadyProcessed(messageId) {
  if (!messageId) return false;

  try {
    const result = await pool.query(
      `
      SELECT id
      FROM conversations
      WHERE whatsapp_message_id = $1
      LIMIT 1
      `,
      [messageId]
    );

    return result.rowCount > 0;

  } catch (err) {
    console.error(
      '❌ خطأ أثناء فحص الرسالة المكررة:',
      err.message
    );

    return false;
  }
}


// =====================================================
// Webhook Verification
// =====================================================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    token === VERIFY_TOKEN
  ) {
    console.log(
      '✅ تم التحقق من الويب هوك بنجاح'
    );

    return res
      .status(200)
      .send(challenge);
  }

  return res.sendStatus(403);
});


// =====================================================
// استقبال رسائل واتساب
// =====================================================

app.post('/webhook', async (req, res) => {

  // الرد على Meta فورًا
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message =
      change?.value?.messages?.[0];

    // حاليًا نتعامل مع الرسائل النصية فقط
    if (
      !message ||
      message.type !== 'text'
    ) {
      return;
    }

    const from = message.from;
    const text = message.text?.body?.trim();
    const messageId = message.id;

    if (!from || !text) {
      return;
    }

    console.log(
      `📩 رسالة من ${from}: ${text}`
    );


    // =================================================
    // منع التكرار
    // =================================================

    const duplicate =
      await messageAlreadyProcessed(
        messageId
      );

    if (duplicate) {
      console.log(
        `⚠️ تم تجاهل رسالة مكررة: ${messageId}`
      );

      return;
    }


    // =================================================
    // نحمل السياق السابق قبل حفظ الرسالة الجديدة
    // =================================================

    const history =
      await getConversationHistory(from);


    // =================================================
    // حفظ رسالة العميل
    // =================================================

    await saveMessage({
      customerPhone: from,
      role: 'user',
      message: text,
      whatsappMessageId: messageId,
    });


    // =================================================
    // توليد رد البوت
    // =================================================

    const reply =
      await generateReply(
        history,
        text
      );


    // =================================================
    // حفظ رد البوت
    // =================================================

    await saveMessage({
      customerPhone: from,
      role: 'assistant',
      message: reply,
    });


    // =================================================
    // إرسال الرد للعميل
    // =================================================

    await sendWhatsAppMessage(
      from,
      reply
    );

  } catch (err) {
    console.error(
      '❌ تفاصيل الخطأ:',
      JSON.stringify(
        err.response?.data ||
        err.message,
        null,
        2
      )
    );
  }
});


// =====================================================
// إرسال رسالة واتساب
// =====================================================

async function sendWhatsAppMessage(
  to,
  text
) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body: text,
      },
    },
    {
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_TOKEN}`,

        'Content-Type':
          'application/json',
      },
    }
  );
}


// =====================================================
// الصفحة الرئيسية
// =====================================================

app.get('/', (req, res) => {
  res.send(
    'Sadin AI Agent — شغال ✅'
  );
});


// =====================================================
// تشغيل السيرفر
// =====================================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(
    `🚀 السيرفر شغال على بورت ${PORT}`
  );

  await initializeDatabase();
});
