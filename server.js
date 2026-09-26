// server.js — Sadin AI Agent
// WhatsApp + PostgreSQL + Admin Reports + Viewing Alerts

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const {
  generateReply,
  extractCompletedViewingRequest,
} = require('./agentBrain');

const app = express();
app.use(express.json());


// =====================================================
// Environment Variables
// =====================================================

const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN;

const WHATSAPP_TOKEN =
  process.env.WHATSAPP_TOKEN;

const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID;

const DATABASE_URL =
  process.env.DATABASE_URL;

const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY;

const ADMIN_REPORT_CODE =
  String(
    process.env.ADMIN_REPORT_CODE || ''
  ).trim();

const ADMIN_WHATSAPP_NUMBERS =
  String(
    process.env.ADMIN_WHATSAPP_NUMBERS || ''
  )
    .split(',')
    .map((number) => number.trim())
    .filter(Boolean);


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
// تجهيز قاعدة البيانات
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


    // جدول طلبات المعاينة
    await pool.query(`
      CREATE TABLE IF NOT EXISTS viewing_requests (
        id BIGSERIAL PRIMARY KEY,

        customer_phone VARCHAR(30)
        NOT NULL,

        property_name TEXT
        NOT NULL,

        requested_day VARCHAR(100)
        NOT NULL,

        requested_time VARCHAR(100)
        NOT NULL,

        customer_type VARCHAR(50)
        NOT NULL,

        status VARCHAR(50)
        NOT NULL DEFAULT 'new',

        created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
      );
    `);


    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_viewing_requests_created_at
      ON viewing_requests(created_at);
    `);


    console.log(
      '✅ قاعدة بيانات العملاء جاهزة'
    );

    console.log(
      '✅ جدول طلبات المعاينة جاهز'
    );

  } catch (err) {

    console.error(
      '❌ خطأ في تجهيز قاعدة البيانات:',
      err.message
    );
  }
}


// =====================================================
// الإدارة
// =====================================================

function isAdminNumber(phone) {
  return ADMIN_WHATSAPP_NUMBERS.includes(
    String(phone).trim()
  );
}


function isAdminReportRequest(
  phone,
  text
) {

  if (!isAdminNumber(phone)) {
    return false;
  }

  if (!ADMIN_REPORT_CODE) {
    return false;
  }

  return (
    String(text || '').trim() ===
    ADMIN_REPORT_CODE
  );
}


// =====================================================
// حفظ الرسائل
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
      '❌ فشل حفظ الرسالة:',
      err.message
    );
  }
}


// =====================================================
// تحميل سياق العميل
// =====================================================

async function getConversationHistory(
  customerPhone
) {

  try {

    const result =
      await pool.query(
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
// منع تكرار الرسائل
// =====================================================

async function messageAlreadyProcessed(
  messageId
) {

  if (!messageId) {
    return false;
  }

  try {

    const result =
      await pool.query(
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
      '❌ خطأ أثناء فحص التكرار:',
      err.message
    );

    return false;
  }
}


// =====================================================
// حفظ طلب المعاينة
// =====================================================

async function saveViewingRequest({
  customerPhone,
  property,
  day,
  time,
  customerType,
}) {

  const result =
    await pool.query(
      `
      INSERT INTO viewing_requests
      (
        customer_phone,
        property_name,
        requested_day,
        requested_time,
        customer_type
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [
        customerPhone,
        property,
        day,
        time,
        customerType,
      ]
    );

  return result.rows[0]?.id;
}


// =====================================================
// إرسال تنبيه المعاينة للإدارة
// =====================================================

async function notifyAdminsAboutViewing({
  requestId,
  customerPhone,
  property,
  day,
  time,
  customerType,
}) {

  if (!ADMIN_WHATSAPP_NUMBERS.length) {

    console.error(
      '⚠️ لا توجد أرقام إدارة لإرسال طلب المعاينة'
    );

    return;
  }


  const alert = `🏠 طلب وقوف / معاينة جديد

رقم الطلب: ${requestId || '-'}

العقار:
${property}

رقم العميل:
${customerPhone}

اليوم:
${day}

الساعة:
${time}

صفة العميل:
${customerType}

📌 يفضّل التواصل مع العميل لتأكيد الموعد.`;


  for (
    const adminPhone
    of ADMIN_WHATSAPP_NUMBERS
  ) {

    try {

      await sendWhatsAppMessage(
        adminPhone,
        alert
      );

      console.log(
        `✅ تم إرسال طلب المعاينة للإدارة: ${adminPhone}`
      );

    } catch (err) {

      console.error(
        `❌ فشل إرسال المعاينة للإدارة ${adminPhone}:`,
        JSON.stringify(
          err.response?.data ||
          err.message,
          null,
          2
        )
      );
    }
  }
}


// =====================================================
// جلب عملاء اليوم
// =====================================================

async function getTodayCustomers() {

  const adminNumbers =
    ADMIN_WHATSAPP_NUMBERS.length
      ? ADMIN_WHATSAPP_NUMBERS
      : ['__NO_ADMIN__'];

  const result =
    await pool.query(
      `
      SELECT DISTINCT customer_phone

      FROM conversations

      WHERE role = 'user'

      AND created_at >=
      (
        DATE_TRUNC(
          'day',
          NOW() AT TIME ZONE 'Asia/Riyadh'
        )
        AT TIME ZONE 'Asia/Riyadh'
      )

      AND created_at <
      (
        (
          DATE_TRUNC(
            'day',
            NOW() AT TIME ZONE 'Asia/Riyadh'
          )
          + INTERVAL '1 day'
        )
        AT TIME ZONE 'Asia/Riyadh'
      )

      AND NOT (
        customer_phone =
        ANY($1::text[])
      )

      ORDER BY customer_phone
      `,
      [adminNumbers]
    );

  return result.rows.map(
    (row) => row.customer_phone
  );
}


// =====================================================
// محادثة العميل اليوم
// =====================================================

async function getTodayConversation(
  customerPhone
) {

  const result =
    await pool.query(
      `
      SELECT
        role,
        message,
        created_at

      FROM conversations

      WHERE customer_phone = $1

      AND created_at >=
      (
        DATE_TRUNC(
          'day',
          NOW() AT TIME ZONE 'Asia/Riyadh'
        )
        AT TIME ZONE 'Asia/Riyadh'
      )

      AND created_at <
      (
        (
          DATE_TRUNC(
            'day',
            NOW() AT TIME ZONE 'Asia/Riyadh'
          )
          + INTERVAL '1 day'
        )
        AT TIME ZONE 'Asia/Riyadh'
      )

      ORDER BY created_at ASC, id ASC
      `,
      [customerPhone]
    );

  return result.rows;
}


// =====================================================
// قراءة JSON من Claude
// =====================================================

function parseClaudeJson(text) {

  if (!text) {
    return null;
  }

  let cleaned =
    String(text)
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

  try {

    return JSON.parse(cleaned);

  } catch (_) {
    // نكمل
  }


  const firstBrace =
    cleaned.indexOf('{');

  const lastBrace =
    cleaned.lastIndexOf('}');


  if (
    firstBrace !== -1 &&
    lastBrace > firstBrace
  ) {

    try {

      return JSON.parse(
        cleaned.slice(
          firstBrace,
          lastBrace + 1
        )
      );

    } catch (_) {

      return null;
    }
  }


  return null;
}


// =====================================================
// تلخيص العميل للتقرير
// =====================================================

async function summarizeCustomer(
  customerPhone,
  conversation
) {

  const conversationText =
    conversation
      .map((row) => {

        const speaker =
          row.role === 'user'
            ? 'العميل'
            : 'المساعد';

        return `${speaker}: ${row.message}`;

      })
      .join('\n');


  const systemPrompt = `
أنت مسؤول CRM لمكتب سدّين للعقار.

استخرج المعلومات المهمة فقط من المحادثة.

ممنوع اختراع أي معلومة.

إذا المعلومة غير موجودة اكتب:
"غير محدد"

أرجع JSON صالح فقط:

{
  "interest": "",
  "property_type": "",
  "district": "",
  "budget": "",
  "property": "",
  "important_request": "",
  "status": "",
  "follow_up": "",
  "summary": ""
}
`;


  try {

    const response =
      await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model:
            'claude-sonnet-5',

          max_tokens:
            700,

          system:
            systemPrompt,

          messages: [
            {
              role: 'user',

              content:
`رقم العميل: ${customerPhone}

محادثة اليوم:

${conversationText}`,
            },
          ],
        },
        {
          headers: {
            'Content-Type':
              'application/json',

            'x-api-key':
              ANTHROPIC_API_KEY,

            'anthropic-version':
              '2023-06-01',
          },

          timeout:
            30000,
        }
      );


    const raw =
      response.data.content
        .map(
          (item) =>
            item.text || ''
        )
        .join('')
        .trim();


    const parsed =
      parseClaudeJson(raw);


    if (parsed) {

      return {
        interest:
          parsed.interest ||
          'غير محدد',

        property_type:
          parsed.property_type ||
          'غير محدد',

        district:
          parsed.district ||
          'غير محدد',

        budget:
          parsed.budget ||
          'غير محدد',

        property:
          parsed.property ||
          'غير محدد',

        important_request:
          parsed.important_request ||
          'غير محدد',

        status:
          parsed.status ||
          'غير محدد',

        follow_up:
          parsed.follow_up ||
          'غير محدد',

        summary:
          parsed.summary ||
          'غير محدد',
      };
    }

  } catch (err) {

    console.error(
      `❌ فشل تلخيص العميل ${customerPhone}:`,
      JSON.stringify(
        err.response?.data ||
        err.message,
        null,
        2
      )
    );
  }


  const userMessages =
    conversation
      .filter(
        (row) =>
          row.role === 'user'
      )
      .map(
        (row) =>
          row.message
      )
      .join(' | ');


  return {
    interest:
      'غير محدد',

    property_type:
      'غير محدد',

    district:
      'غير محدد',

    budget:
      'غير محدد',

    property:
      'غير محدد',

    important_request:
      userMessages ||
      'غير محدد',

    status:
      'غير محدد',

    follow_up:
      'مراجعة المحادثة',

    summary:
      userMessages ||
      'غير محدد',
  };
}


// =====================================================
// تاريخ السعودية
// =====================================================

function getSaudiDateString() {

  const formatter =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone:
          'Asia/Riyadh',

        year:
          'numeric',

        month:
          '2-digit',

        day:
          '2-digit',
      }
    );

  return formatter.format(
    new Date()
  );
}


// =====================================================
// إنشاء تقرير Excel
// =====================================================

async function createDailyReport() {

  const customers =
    await getTodayCustomers();


  if (!customers.length) {

    return {
      hasCustomers: false,
      buffer: null,
      filename: null,
      count: 0,
    };
  }


  const reportRows = [];


  for (
    const phone
    of customers
  ) {

    const conversation =
      await getTodayConversation(
        phone
      );


    if (!conversation.length) {
      continue;
    }


    const summary =
      await summarizeCustomer(
        phone,
        conversation
      );


    reportRows.push({

      'رقم العميل':
        phone,

      'الاهتمام':
        summary.interest,

      'نوع العقار':
        summary.property_type,

      'الحي / الموقع':
        summary.district,

      'الميزانية':
        summary.budget,

      'العقار المهتم به':
        summary.property,

      'أهم طلب أو سؤال':
        summary.important_request,

      'حالة العميل':
        summary.status,

      'المتابعة المقترحة':
        summary.follow_up,

      'ملخص المحادثة':
        summary.summary,
    });
  }


  if (!reportRows.length) {

    return {
      hasCustomers: false,
      buffer: null,
      filename: null,
      count: 0,
    };
  }


  const worksheet =
    XLSX.utils.json_to_sheet(
      reportRows
    );


  worksheet['!cols'] = [
    { wch: 18 },
    { wch: 25 },
    { wch: 18 },
    { wch: 20 },
    { wch: 18 },
    { wch: 28 },
    { wch: 45 },
    { wch: 20 },
    { wch: 35 },
    { wch: 60 },
  ];


  const workbook =
    XLSX.utils.book_new();


  XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    'عملاء اليوم'
  );


  const buffer =
    XLSX.write(
      workbook,
      {
        type: 'buffer',
        bookType: 'xlsx',
      }
    );


  const date =
    getSaudiDateString();


  return {
    hasCustomers:
      true,

    buffer,

    filename:
      `Sadin-Leads-${date}.xlsx`,

    count:
      reportRows.length,
  };
}


// =====================================================
// رفع التقرير لواتساب
// =====================================================

async function uploadDocumentToWhatsApp(
  buffer,
  filename
) {

  const form =
    new FormData();


  const blob =
    new Blob(
      [buffer],
      {
        type:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }
    );


  form.append(
    'messaging_product',
    'whatsapp'
  );

  form.append(
    'type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  form.append(
    'file',
    blob,
    filename
  );


  const response =
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization:
            `Bearer ${WHATSAPP_TOKEN}`,
        },

        timeout:
          60000,
      }
    );


  return response.data.id;
}


// =====================================================
// إرسال مستند
// =====================================================

async function sendWhatsAppDocument(
  to,
  mediaId,
  filename,
  caption
) {

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product:
        'whatsapp',

      to,

      type:
        'document',

      document: {
        id:
          mediaId,

        filename,

        caption,
      },
    },
    {
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_TOKEN}`,

        'Content-Type':
          'application/json',
      },

      timeout:
        60000,
    }
  );
}


// =====================================================
// التقرير الإداري
// =====================================================

async function handleAdminReport(
  adminPhone
) {

  try {

    console.log(
      `🔐 طلب تقرير إداري من ${adminPhone}`
    );


    await sendWhatsAppMessage(
      adminPhone,
      'أبشر 👍 جاري تجهيز تقرير عملاء اليوم، لحظات...'
    );


    const report =
      await createDailyReport();


    if (!report.hasCustomers) {

      await sendWhatsAppMessage(
        adminPhone,
        'ما فيه عملاء مسجلين اليوم حتى الآن.'
      );

      return;
    }


    const mediaId =
      await uploadDocumentToWhatsApp(
        report.buffer,
        report.filename
      );


    await sendWhatsAppDocument(
      adminPhone,
      mediaId,
      report.filename,
      `تقرير عملاء سدّين لليوم 🏠\nعدد العملاء: ${report.count}`
    );


    console.log(
      `✅ تم إرسال التقرير إلى ${adminPhone}`
    );

  } catch (err) {

    console.error(
      '❌ فشل إنشاء أو إرسال التقرير:',
      JSON.stringify(
        err.response?.data ||
        err.message,
        null,
        2
      )
    );


    try {

      await sendWhatsAppMessage(
        adminPhone,
        'صار خطأ أثناء تجهيز التقرير. جرّب مرة ثانية بعد شوي.'
      );

    } catch (_) {}
  }
}


// =====================================================
// Webhook Verification
// =====================================================

app.get(
  '/webhook',
  (req, res) => {

    const mode =
      req.query['hub.mode'];

    const token =
      req.query[
        'hub.verify_token'
      ];

    const challenge =
      req.query[
        'hub.challenge'
      ];


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
  }
);


// =====================================================
// استقبال واتساب
// =====================================================

app.post(
  '/webhook',
  async (req, res) => {

    // نرد على Meta فورًا
    res.sendStatus(200);


    try {

      const entry =
        req.body.entry?.[0];

      const change =
        entry?.changes?.[0];

      const message =
        change?.value
          ?.messages?.[0];


      if (
        !message ||
        message.type !== 'text'
      ) {
        return;
      }


      const from =
        message.from;

      const text =
        message.text
          ?.body
          ?.trim();

      const messageId =
        message.id;


      if (!from || !text) {
        return;
      }


      // =================================================
      // التقرير السري
      // =================================================

      if (
        isAdminReportRequest(
          from,
          text
        )
      ) {

        console.log(
          '🔐 تم التعرف على طلب التقرير الإداري'
        );


        await handleAdminReport(
          from
        );

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
      // السياق السابق
      // =================================================

      const history =
        await getConversationHistory(
          from
        );


      // =================================================
      // حفظ رسالة العميل
      // =================================================

      await saveMessage({
        customerPhone:
          from,

        role:
          'user',

        message:
          text,

        whatsappMessageId:
          messageId,
      });


      // =================================================
      // توليد الرد
      // =================================================

      const reply =
        await generateReply(
          history,
          text
        );


      // =================================================
      // هل اكتمل طلب معاينة؟
      // مهم: نستخدم history قبل إضافة الرسالة الحالية
      // لأن userText يتم تمريره منفصلًا
      // =================================================

      const viewingRequest =
        extractCompletedViewingRequest(
          history,
          text,
          reply
        );


      // =================================================
      // حفظ رد البوت
      // =================================================

      await saveMessage({
        customerPhone:
          from,

        role:
          'assistant',

        message:
          reply,
      });


      // =================================================
      // إرسال الرد للعميل
      // =================================================

      await sendWhatsAppMessage(
        from,
        reply
      );


      // =================================================
      // لو طلب معاينة مكتمل
      // =================================================

      if (viewingRequest) {

        try {

          const requestId =
            await saveViewingRequest({
              customerPhone:
                from,

              property:
                viewingRequest.property,

              day:
                viewingRequest.day,

              time:
                viewingRequest.time,

              customerType:
                viewingRequest.customerType,
            });


          console.log(
            `🏠 تم تسجيل طلب معاينة رقم ${requestId}`
          );


          await notifyAdminsAboutViewing({
            requestId,

            customerPhone:
              from,

            property:
              viewingRequest.property,

            day:
              viewingRequest.day,

            time:
              viewingRequest.time,

            customerType:
              viewingRequest.customerType,
          });


        } catch (viewingError) {

          console.error(
            '❌ خطأ في تسجيل/إرسال طلب المعاينة:',
            JSON.stringify(
              viewingError.response?.data ||
              viewingError.message,
              null,
              2
            )
          );
        }
      }


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
  }
);


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
      messaging_product:
        'whatsapp',

      to,

      type:
        'text',

      text: {
        body:
          text,
      },
    },
    {
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_TOKEN}`,

        'Content-Type':
          'application/json',
      },

      timeout:
        30000,
    }
  );
}


// =====================================================
// الصفحة الرئيسية
// =====================================================

app.get(
  '/',
  (req, res) => {

    res.send(
      'Sadin AI Agent — شغال ✅'
    );
  }
);


// =====================================================
// تشغيل السيرفر
// =====================================================

const PORT =
  process.env.PORT || 3000;


app.listen(
  PORT,
  async () => {

    console.log(
      `🚀 السيرفر شغال على بورت ${PORT}`
    );

    console.log(
      `🔐 عدد أرقام الإدارة: ${ADMIN_WHATSAPP_NUMBERS.length}`
    );

    await initializeDatabase();
  }
);
