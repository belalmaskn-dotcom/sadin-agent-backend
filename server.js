require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const {
  generateReply,
  generateStickerReply,
  isViewingRequest,
  extractViewingData,
  detectCurrentProperty,
} = require('./agentBrain');

const app = express();

app.use(
  express.json({
    limit: '25mb',
  })
);

const PORT =
  Number(process.env.PORT) ||
  3000;

const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN ||
  '';

const WHATSAPP_TOKEN =
  process.env.WHATSAPP_TOKEN ||
  '';

const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  '';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  '';

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ||
  '';

const ADMIN_REPORT_CODE =
  process.env.ADMIN_REPORT_CODE ||
  '';

const ADMIN_WHATSAPP_NUMBERS =
  String(
    process.env.ADMIN_WHATSAPP_NUMBERS ||
    ''
  )
    .split(',')
    .map(
      (number) =>
        number.replace(/\D/g, '')
    )
    .filter(Boolean);

const CONTACT_NUMBER =
  '0530084666';


// =====================================================
// إعدادات الرسائل الجماعية (Broadcast)
// =====================================================

const BROADCAST_PASSWORD =
  process.env.BROADCAST_PASSWORD ||
  '';

const BROADCAST_TEMPLATE_NAME =
  process.env.BROADCAST_TEMPLATE_NAME ||
  'sadin_property_offer';

const BROADCAST_TEMPLATE_LANG =
  process.env.BROADCAST_TEMPLATE_LANG ||
  'ar';

// أقصى عدد أرقام في المرة الواحدة
const BROADCAST_MAX_PER_RUN = 250;

// فاصل بين كل رسالة والتانية (بالملي ثانية)
const BROADCAST_DELAY_MS = 1500;

// الاسم اللي يتحط لو العميل ملوش اسم في القائمة
const BROADCAST_DEFAULT_NAME = 'عميلنا الكريم';

// نسخة من نص القالب (لازم تكون نفس النص المعتمد في ميتا)
// بتتحفظ في سجل المحادثة عشان البوت يفهم العميل بيرد على إيه
const BROADCAST_TEMPLATE_PREVIEW =
`أهلاً {{1}} 👋

✨ *شقق تمليك فاخرة* ✨

🕌 بجوار المسجد النبوي الشريف
🏙️ في أرقى أحياء المدينة المنورة

تحب نرسل لك التفاصيل والأسعار؟
رد على هذه الرسالة ويساعدك مستشارنا فورًا 🌿`;


// =====================================================
// PostgreSQL
// =====================================================

const pool =
  new Pool({
    connectionString:
      DATABASE_URL,

    ssl:
      DATABASE_URL &&
      !DATABASE_URL.includes(
        'localhost'
      )
        ? {
            rejectUnauthorized:
              false,
          }
        : false,
  });


pool.on(
  'error',
  (err) => {

    console.error(
      'PostgreSQL pool error:',
      err
    );
  }
);


// =====================================================
// إنشاء الجداول
// =====================================================

async function initializeDatabase() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_phone VARCHAR(30) NOT NULL,
      role VARCHAR(20) NOT NULL,
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_phone
    ON conversations(customer_phone);
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS viewing_requests (
      id SERIAL PRIMARY KEY,
      customer_phone VARCHAR(30) NOT NULL,
      property_name TEXT,
      requested_day VARCHAR(100),
      requested_time VARCHAR(100),
      customer_type VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS viewing_sessions (
      customer_phone VARCHAR(30) PRIMARY KEY,
      property_name TEXT,
      requested_day VARCHAR(100),
      requested_time VARCHAR(100),
      customer_type VARCHAR(50),
      status VARCHAR(30) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS opt_outs (
      customer_phone VARCHAR(30) PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcast_log (
      id SERIAL PRIMARY KEY,
      customer_phone VARCHAR(30) NOT NULL,
      customer_name TEXT,
      template_name VARCHAR(100),
      status VARCHAR(30),
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);


  console.log(
    'Database tables ready'
  );
}


// =====================================================
// Health
// =====================================================

app.get(
  '/',
  (req, res) => {

    res
      .status(200)
      .send(
        'Sadin AI Agent is running'
      );
  }
);


app.get(
  '/health',
  async (req, res) => {

    try {

      await pool.query(
        'SELECT 1'
      );


      res.json({
        ok: true,
        database: true,
      });

    } catch (err) {

      console.error(
        'Health check error:',
        err
      );


      res
        .status(500)
        .json({
          ok: false,
          database: false,
        });
    }
  }
);


// =====================================================
// Webhook verification
// =====================================================

app.get(
  '/webhook',
  (req, res) => {

    const mode =
      req.query[
        'hub.mode'
      ];

    const token =
      req.query[
        'hub.verify_token'
      ];

    const challenge =
      req.query[
        'hub.challenge'
      ];


    if (
      mode ===
        'subscribe' &&
      token ===
        VERIFY_TOKEN
    ) {

      console.log(
        'Webhook verified'
      );


      return res
        .status(200)
        .send(challenge);
    }


    return res.sendStatus(
      403
    );
  }
);


// =====================================================
// WhatsApp helpers
// =====================================================

function normalizePhone(
  phone
) {

  return String(
    phone || ''
  ).replace(
    /\D/g,
    ''
  );
}


function isAdminPhone(
  phone
) {

  const normalized =
    normalizePhone(
      phone
    );


  return ADMIN_WHATSAPP_NUMBERS.includes(
    normalized
  );
}


// =====================================================
// إرسال رسالة نصية
// =====================================================

async function sendWhatsAppText(
  to,
  body
) {

  if (
    !WHATSAPP_TOKEN ||
    !PHONE_NUMBER_ID
  ) {

    console.error(
      'WhatsApp credentials missing'
    );

    return false;
  }


  try {

    await axios.post(

      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,

      {
        messaging_product:
          'whatsapp',

        recipient_type:
          'individual',

        to:
          normalizePhone(to),

        type:
          'text',

        text: {
          preview_url:
            false,

          body:
            String(body || ''),
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


    return true;

  } catch (err) {

    console.error(
      'WhatsApp send text error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return false;
  }
}


// =====================================================
// معلومات ملف WhatsApp Media
// =====================================================

async function getWhatsAppMediaInfo(
  mediaId
) {

  if (
    !mediaId ||
    !WHATSAPP_TOKEN
  ) {

    return null;
  }


  try {

    const response =
      await axios.get(

        `https://graph.facebook.com/v23.0/${mediaId}`,

        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,
          },

          timeout:
            30000,
        }
      );


    return response.data;

  } catch (err) {

    console.error(
      'Get WhatsApp media info error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return null;
  }
}


// =====================================================
// تحميل WhatsApp Media
// =====================================================

async function downloadWhatsAppMedia(
  mediaId
) {

  const info =
    await getWhatsAppMediaInfo(
      mediaId
    );


  if (
    !info ||
    !info.url
  ) {

    return null;
  }


  try {

    const response =
      await axios.get(
        info.url,
        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,
          },

          responseType:
            'arraybuffer',

          timeout:
            60000,
        }
      );


    return {
      buffer:
        Buffer.from(
          response.data
        ),

      mimeType:
        info.mime_type ||
        response.headers[
          'content-type'
        ] ||
        'application/octet-stream',

      sha256:
        info.sha256 ||
        null,

      fileSize:
        info.file_size ||
        null,
    };

  } catch (err) {

    console.error(
      'Download WhatsApp media error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return null;
  }
}


// =====================================================
// تحويل الريكورد إلى نص
// =====================================================

function extensionFromMimeType(
  mimeType = ''
) {

  const type =
    String(
      mimeType
    ).toLowerCase();


  if (
    type.includes(
      'ogg'
    )
  ) {

    return 'ogg';
  }


  if (
    type.includes(
      'mpeg'
    ) ||
    type.includes(
      'mp3'
    )
  ) {

    return 'mp3';
  }


  if (
    type.includes(
      'mp4'
    ) ||
    type.includes(
      'm4a'
    )
  ) {

    return 'm4a';
  }


  if (
    type.includes(
      'wav'
    )
  ) {

    return 'wav';
  }


  if (
    type.includes(
      'webm'
    )
  ) {

    return 'webm';
  }


  return 'ogg';
}


async function transcribeAudio(
  audioBuffer,
  mimeType
) {

  if (
    !OPENAI_API_KEY
  ) {

    console.error(
      'OPENAI_API_KEY is missing'
    );

    return null;
  }


  if (
    !audioBuffer ||
    !audioBuffer.length
  ) {

    return null;
  }


  try {

    const extension =
      extensionFromMimeType(
        mimeType
      );


    const form =
      new FormData();


    const blob =
      new Blob(
        [audioBuffer],
        {
          type:
            mimeType ||
            'audio/ogg',
        }
      );


    form.append(
      'file',
      blob,
      `voice.${extension}`
    );


    form.append(
      'model',
      'gpt-4o-mini-transcribe'
    );


    const response =
      await axios.post(

        'https://api.openai.com/v1/audio/transcriptions',

        form,

        {
          headers: {
            Authorization:
              `Bearer ${OPENAI_API_KEY}`,
          },

          timeout:
            120000,

          maxBodyLength:
            Infinity,

          maxContentLength:
            Infinity,
        }
      );


    const text =
      response.data?.text;


    if (
      !text ||
      !String(text).trim()
    ) {

      return null;
    }


    console.log(
      'Voice transcription:',
      String(text).trim()
    );


    return String(
      text
    ).trim();

  } catch (err) {

    console.error(
      'Audio transcription error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return null;
  }
}


// =====================================================
// Sticker → وصف نصي
// =====================================================

async function describeSticker(
  stickerBuffer,
  mimeType
) {

  if (
    !OPENAI_API_KEY
  ) {

    console.error(
      'OPENAI_API_KEY is missing'
    );

    return null;
  }


  if (
    !stickerBuffer ||
    !stickerBuffer.length
  ) {

    return null;
  }


  try {

    const actualMime =
      mimeType ||
      'image/webp';


    const base64 =
      stickerBuffer.toString(
        'base64'
      );


    const dataUrl =
      `data:${actualMime};base64,${base64}`;


    const response =
      await axios.post(

        'https://api.openai.com/v1/responses',

        {
          model:
            'gpt-4.1-mini',

          input: [
            {
              role:
                'user',

              content: [
                {
                  type:
                    'input_text',

                  text:
`حلل هذا الاستيكر المرسل في محادثة واتساب.

اكتب وصفًا مختصرًا جدًا لمعناه أو التعبير الذي يوصله.

ركز على:
- هل هو ضحك؟
- تحية؟
- شكر؟
- موافقة؟
- استغراب؟
- حزن؟
- فرح؟
- رفض؟
- أو يحتوي على كلام مكتوب؟

إذا كان فيه كلام عربي أو إنجليزي، اذكر الكلام في الوصف.

لا ترد على صاحب الاستيكر.
فقط صف معنى الاستيكر لكي يستخدمه مساعد آخر للرد.`,
                },

                {
                  type:
                    'input_image',

                  image_url:
                    dataUrl,
                },
              ],
            },
          ],

          max_output_tokens:
            150,
        },

        {
          headers: {
            Authorization:
              `Bearer ${OPENAI_API_KEY}`,

            'Content-Type':
              'application/json',
          },

          timeout:
            60000,

          maxBodyLength:
            Infinity,
        }
      );


    const directText =
      response.data?.output_text;


    if (
      directText &&
      String(
        directText
      ).trim()
    ) {

      return String(
        directText
      ).trim();
    }


    const output =
      response.data?.output ||
      [];


    for (
      const item
      of output
    ) {

      const content =
        item.content ||
        [];


      for (
        const part
        of content
      ) {

        if (
          part.type ===
            'output_text' &&
          part.text
        ) {

          return String(
            part.text
          ).trim();
        }
      }
    }


    return null;

  } catch (err) {

    console.error(
      'Sticker analysis error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return null;
  }
}


// =====================================================
// حفظ المحادثة
// =====================================================

async function saveConversation(
  customerPhone,
  role,
  message
) {

  try {

    await pool.query(
      `
      INSERT INTO conversations
      (
        customer_phone,
        role,
        message
      )
      VALUES ($1, $2, $3)
      `,
      [
        normalizePhone(
          customerPhone
        ),

        role,

        String(
          message || ''
        ),
      ]
    );

  } catch (err) {

    console.error(
      'Save conversation error:',
      err
    );
  }
}


// =====================================================
// جلب المحادثة
// =====================================================

async function getConversationHistory(
  customerPhone,
  limit = 20
) {

  try {

    const result =
      await pool.query(
        `
        SELECT
          role,
          message,
          created_at
        FROM conversations
        WHERE customer_phone = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
        `,
        [
          normalizePhone(
            customerPhone
          ),

          limit,
        ]
      );


    return result.rows
      .reverse()
      .map(
        (row) => ({
          role:
            row.role ===
            'assistant'
              ? 'assistant'
              : 'user',

          content:
            row.message,
        })
      );

  } catch (err) {

    console.error(
      'Get conversation history error:',
      err
    );


    return [];
  }
}


// =====================================================
// Viewing sessions
// =====================================================

async function getViewingSession(
  customerPhone
) {

  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM viewing_sessions
        WHERE customer_phone = $1
          AND status = 'active'
        LIMIT 1
        `,
        [
          normalizePhone(
            customerPhone
          ),
        ]
      );


    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Get viewing session error:',
      err
    );


    return null;
  }
}


async function startViewingSession(
  customerPhone,
  propertyName
) {

  try {

    const result =
      await pool.query(
        `
        INSERT INTO viewing_sessions
        (
          customer_phone,
          property_name,
          requested_day,
          requested_time,
          customer_type,
          status,
          created_at,
          updated_at
        )
        VALUES
        (
          $1,
          $2,
          NULL,
          NULL,
          NULL,
          'active',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )

        ON CONFLICT
        (customer_phone)

        DO UPDATE SET

          property_name =
            EXCLUDED.property_name,

          requested_day =
            NULL,

          requested_time =
            NULL,

          customer_type =
            NULL,

          status =
            'active',

          created_at =
            CURRENT_TIMESTAMP,

          updated_at =
            CURRENT_TIMESTAMP

        RETURNING *
        `,
        [
          normalizePhone(
            customerPhone
          ),

          propertyName ||
          'العقار الحالي',
        ]
      );


    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Start viewing session error:',
      err
    );


    return null;
  }
}


async function updateViewingSession(
  customerPhone,
  fields = {}
) {

  const updates =
    [];

  const values =
    [];

  let index =
    1;


  if (
    fields.propertyName !==
    undefined
  ) {

    updates.push(
      `property_name = $${index++}`
    );

    values.push(
      fields.propertyName
    );
  }


  if (
    fields.day !==
    undefined
  ) {

    updates.push(
      `requested_day = $${index++}`
    );

    values.push(
      fields.day
    );
  }


  if (
    fields.time !==
    undefined
  ) {

    updates.push(
      `requested_time = $${index++}`
    );

    values.push(
      fields.time
    );
  }


  if (
    fields.customerType !==
    undefined
  ) {

    updates.push(
      `customer_type = $${index++}`
    );

    values.push(
      fields.customerType
    );
  }


  if (
    !updates.length
  ) {

    return getViewingSession(
      customerPhone
    );
  }


  updates.push(
    'updated_at = CURRENT_TIMESTAMP'
  );


  values.push(
    normalizePhone(
      customerPhone
    )
  );


  try {

    const result =
      await pool.query(
        `
        UPDATE viewing_sessions
        SET
          ${updates.join(', ')}
        WHERE
          customer_phone =
          $${index}
          AND status = 'active'
        RETURNING *
        `,
        values
      );


    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Update viewing session error:',
      err
    );


    return null;
  }
}


async function closeViewingSession(
  customerPhone
) {

  try {

    await pool.query(
      `
      UPDATE viewing_sessions
      SET
        status = 'completed',
        updated_at = CURRENT_TIMESTAMP
      WHERE customer_phone = $1
        AND status = 'active'
      `,
      [
        normalizePhone(
          customerPhone
        ),
      ]
    );

  } catch (err) {

    console.error(
      'Close viewing session error:',
      err
    );
  }
}


// =====================================================
// حفظ طلب المعاينة
// =====================================================

async function saveViewingRequest(
  request
) {

  try {

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
        VALUES
        ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [
          normalizePhone(
            request.customerPhone
          ),

          request.propertyName,

          request.day,

          request.time,

          request.customerType,
        ]
      );


    return (
      result.rows[0] ||
      null
    );

  } catch (err) {

    console.error(
      'Save viewing request error:',
      err
    );


    return null;
  }
}


// =====================================================
// تنبيه الإدارة بطلب المعاينة
// =====================================================

async function notifyAdminsAboutViewing(
  request
) {

  if (
    !ADMIN_WHATSAPP_NUMBERS.length
  ) {

    return;
  }


  const message =
`🏠 طلب معاينة جديد

العقار:
${request.propertyName}

العميل:
${request.customerPhone}

اليوم:
${request.day}

الوقت:
${request.time}

الصفة:
${request.customerType}`;


  for (
    const adminPhone
    of ADMIN_WHATSAPP_NUMBERS
  ) {

    await sendWhatsAppText(
      adminPhone,
      message
    );
  }
}


// =====================================================
// معالجة المعاينة
// =====================================================

async function processViewingFlow({
  customerPhone,
  userText,
  history,
}) {

  let session =
    await getViewingSession(
      customerPhone
    );


  const newViewingRequest =
    isViewingRequest(
      userText
    );


  // لا يوجد موعد نشط
  // والعميل لم يبدأ معاينة جديدة

  if (
    !session &&
    !newViewingRequest
  ) {

    return null;
  }


  // بدء جلسة جديدة

  if (
    !session &&
    newViewingRequest
  ) {

    const propertyName =
      detectCurrentProperty(
        history,
        userText
      );


    session =
      await startViewingSession(
        customerPhone,
        propertyName
      );


    if (!session) {

      return null;
    }
  }


  // نقرأ الرسالة الحالية فقط.

  const extracted =
    extractViewingData(
      [],
      userText
    );


  const updates =
    {};


  if (
    extracted.day
  ) {

    updates.day =
      extracted.day;
  }


  if (
    extracted.time
  ) {

    updates.time =
      extracted.time;
  }


  if (
    extracted.customerType
  ) {

    updates.customerType =
      extracted.customerType;
  }


  if (
    Object.keys(
      updates
    ).length
  ) {

    const updatedSession =
      await updateViewingSession(
        customerPhone,
        updates
      );


    if (
      updatedSession
    ) {

      session =
        updatedSession;
    }
  }


  if (
    !session.requested_day
  ) {

    return {
      handled: true,

      completed: false,

      reply:
        'أبشر 👍 حدد لي أي يوم حاب توقف على العقار؟',
    };
  }


  if (
    !session.requested_time
  ) {

    return {
      handled: true,

      completed: false,

      reply:
`تمام 👍 يوم ${session.requested_day}. الساعة كم يناسبك؟`,
    };
  }


  if (
    !session.customer_type
  ) {

    return {
      handled: true,

      completed: false,

      reply:
        'تمام 👍 هل أنت المشتري ولا مكتب عقاري؟',
    };
  }


  const completedRequest =
    {
      customerPhone:
        normalizePhone(
          customerPhone
        ),

      propertyName:
        session.property_name ||
        'العقار الحالي',

      day:
        session.requested_day,

      time:
        session.requested_time,

      customerType:
        session.customer_type,
    };


  // مهم:
  // نقفل الجلسة قبل الرد النهائي
  // حتى لا ترجع تفتح بعد "السلام عليكم".

  await closeViewingSession(
    customerPhone
  );


  return {
    handled: true,

    completed: true,

    request:
      completedRequest,

    reply:
`تم تسجيل طلب الوقوف على ${completedRequest.propertyName} 👍

اليوم: ${completedRequest.day}
الوقت: ${completedRequest.time}
الصفة: ${completedRequest.customerType}

تواصل على الرقم ${CONTACT_NUMBER} لإكمال التنسيق.`,
  };
}


// =====================================================
// تقارير الإدارة
// =====================================================

function isAdminReportCommand(
  text
) {

  const value =
    String(
      text || ''
    ).trim();


  if (
    !ADMIN_REPORT_CODE
  ) {

    return false;
  }


  return (
    value ===
      ADMIN_REPORT_CODE ||

    value ===
      `${ADMIN_REPORT_CODE} تقرير` ||

    value ===
      `${ADMIN_REPORT_CODE} report`
  );
}


async function buildAdminSummary() {

  const [
    conversationResult,
    customerResult,
    viewingResult,
    todayViewingResult,
  ] =
    await Promise.all([

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM conversations
      `),

      pool.query(`
        SELECT COUNT(
          DISTINCT customer_phone
        )::int AS count
        FROM conversations
        WHERE role = 'user'
      `),

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM viewing_requests
      `),

      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM viewing_requests
        WHERE created_at >=
          CURRENT_DATE
      `),
    ]);


  return (
`📊 تقرير سدّين

إجمالي الرسائل المسجلة:
${conversationResult.rows[0]?.count || 0}

عدد العملاء:
${customerResult.rows[0]?.count || 0}

إجمالي طلبات المعاينة:
${viewingResult.rows[0]?.count || 0}

طلبات المعاينة اليوم:
${todayViewingResult.rows[0]?.count || 0}`
  );
}


// =====================================================
// إنشاء Excel
// =====================================================

async function createReportWorkbook() {

  const conversations =
    await pool.query(`
      SELECT
        id,
        customer_phone,
        role,
        message,
        created_at
      FROM conversations
      ORDER BY created_at DESC
    `);


  const viewings =
    await pool.query(`
      SELECT
        id,
        customer_phone,
        property_name,
        requested_day,
        requested_time,
        customer_type,
        created_at
      FROM viewing_requests
      ORDER BY created_at DESC
    `);


  const workbook =
    XLSX.utils.book_new();


  const conversationSheet =
    XLSX.utils.json_to_sheet(
      conversations.rows
    );


  const viewingSheet =
    XLSX.utils.json_to_sheet(
      viewings.rows
    );


  XLSX.utils.book_append_sheet(
    workbook,
    conversationSheet,
    'Conversations'
  );


  XLSX.utils.book_append_sheet(
    workbook,
    viewingSheet,
    'Viewing Requests'
  );


  return XLSX.write(
    workbook,
    {
      type:
        'buffer',

      bookType:
        'xlsx',
    }
  );
}


// =====================================================
// رفع ملف Excel إلى WhatsApp
// =====================================================

async function uploadWhatsAppDocument(
  buffer,
  filename
) {

  try {

    const form =
      new FormData();


    form.append(
      'messaging_product',
      'whatsapp'
    );


    const blob =
      new Blob(
        [buffer],
        {
          type:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }
      );


    form.append(
      'file',
      blob,
      filename
    );


    const response =
      await axios.post(

        `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/media`,

        form,

        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,
          },

          timeout:
            60000,

          maxBodyLength:
            Infinity,

          maxContentLength:
            Infinity,
        }
      );


    return (
      response.data?.id ||
      null
    );

  } catch (err) {

    console.error(
      'Upload WhatsApp document error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return null;
  }
}


// =====================================================
// إرسال ملف واتساب
// =====================================================

async function sendWhatsAppDocument(
  to,
  mediaId,
  filename,
  caption = ''
) {

  try {

    await axios.post(

      `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,

      {
        messaging_product:
          'whatsapp',

        to:
          normalizePhone(to),

        type:
          'document',

        document: {
          id:
            mediaId,

          filename,

          caption:
            caption || undefined,
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


    return true;

  } catch (err) {

    console.error(
      'Send WhatsApp document error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return false;
  }
}


// =====================================================
// إرسال تقرير Excel للإدارة
// =====================================================

async function sendAdminExcelReport(
  adminPhone
) {

  try {

    const buffer =
      await createReportWorkbook();


    const filename =
      `sadin-report-${Date.now()}.xlsx`;


    const mediaId =
      await uploadWhatsAppDocument(
        buffer,
        filename
      );


    if (!mediaId) {

      await sendWhatsAppText(
        adminPhone,
        'تعذر إنشاء تقرير Excel حاليًا.'
      );

      return;
    }


    await sendWhatsAppDocument(
      adminPhone,
      mediaId,
      filename,
      '📊 تقرير سدّين الكامل'
    );

  } catch (err) {

    console.error(
      'Admin Excel report error:',
      err
    );


    await sendWhatsAppText(
      adminPhone,
      'تعذر إرسال تقرير Excel حاليًا.'
    );
  }
}


// =====================================================
// تحويل رسالة WhatsApp إلى نص قابل للمعالجة
// =====================================================

async function extractIncomingContent(
  message
) {

  if (
    !message ||
    !message.type
  ) {

    return {
      type:
        'unsupported',

      text:
        null,
    };
  }


  // =================================================
  // Text
  // =================================================

  if (
    message.type ===
    'text'
  ) {

    return {
      type:
        'text',

      text:
        message.text?.body ||
        '',
    };
  }


  // =================================================
  // Voice / Audio
  // =================================================

  if (
    message.type ===
    'audio'
  ) {

    const mediaId =
      message.audio?.id;


    if (!mediaId) {

      return {
        type:
          'audio',

        text:
          null,
      };
    }


    console.log(
      'Voice message received:',
      mediaId
    );


    const media =
      await downloadWhatsAppMedia(
        mediaId
      );


    if (!media) {

      return {
        type:
          'audio',

        text:
          null,
      };
    }


    const transcription =
      await transcribeAudio(
        media.buffer,
        media.mimeType
      );


    return {
      type:
        'audio',

      text:
        transcription,
    };
  }


  // =================================================
  // Sticker
  // =================================================

  if (
    message.type ===
    'sticker'
  ) {

    const mediaId =
      message.sticker?.id;


    if (!mediaId) {

      return {
        type:
          'sticker',

        text:
          null,

        stickerDescription:
          null,
      };
    }


    console.log(
      'Sticker received:',
      mediaId
    );


    const media =
      await downloadWhatsAppMedia(
        mediaId
      );


    if (!media) {

      return {
        type:
          'sticker',

        text:
          null,

        stickerDescription:
          null,
      };
    }


    const description =
      await describeSticker(
        media.buffer,
        media.mimeType
      );


    return {
      type:
        'sticker',

      text:
        null,

      stickerDescription:
        description,
    };
  }


  return {
    type:
      'unsupported',

    text:
      null,
  };
}


// =====================================================
// معالجة رسالة عميل واحدة
// =====================================================

async function processCustomerMessage(
  message
) {

  const from =
    normalizePhone(
      message.from
    );


  if (!from) {

    return;
  }


  const incoming =
    await extractIncomingContent(
      message
    );


  // =================================================
  // Sticker
  // =================================================

  if (
    incoming.type ===
    'sticker'
  ) {

    console.log(
      'Sticker description:',
      incoming.stickerDescription
    );


    const reply =
      await generateStickerReply(
        incoming.stickerDescription
      );


    // نخزن وصف الاستيكر في السجل
    // بدل تخزين binary.

    await saveConversation(
      from,
      'user',
      incoming.stickerDescription
        ? `[Sticker] ${incoming.stickerDescription}`
        : '[Sticker]'
    );


    await sendWhatsAppText(
      from,
      reply
    );


    await saveConversation(
      from,
      'assistant',
      reply
    );


    return;
  }


  // =================================================
  // Unsupported
  // =================================================

  if (
    incoming.type ===
    'unsupported'
  ) {

    console.log(
      'Unsupported WhatsApp message:',
      message.type
    );


    return;
  }


  // =================================================
  // فشل تحويل الصوت
  // =================================================

  if (
    incoming.type ===
      'audio' &&
    !incoming.text
  ) {

    const reply =
      'ما قدرت أسمع التسجيل بوضوح 🌹 ممكن تعيد إرسال الريكورد أو تكتب لي طلبك؟';


    await sendWhatsAppText(
      from,
      reply
    );


    await saveConversation(
      from,
      'assistant',
      reply
    );


    return;
  }


  const userText =
    String(
      incoming.text ||
      ''
    ).trim();


  if (!userText) {

    return;
  }


  // =================================================
  // طلب إيقاف الرسائل الترويجية
  // =================================================

  if (
    isOptOutMessage(
      userText
    )
  ) {

    await saveOptOut(
      from
    );


    const reply =
      'تم إيقاف الرسائل الترويجية ✅ ما راح نرسل لك عروض مرة ثانية. ولو احتجت أي شي، راسلنا في أي وقت 🌹';


    await saveConversation(
      from,
      'user',
      userText
    );


    await sendWhatsAppText(
      from,
      reply
    );


    await saveConversation(
      from,
      'assistant',
      reply
    );


    return;
  }


  console.log(
    `${incoming.type} from ${from}:`,
    userText
  );


  // =================================================
  // أوامر الإدارة
  // =================================================

  if (
    isAdminPhone(
      from
    ) &&
    isAdminReportCommand(
      userText
    )
  ) {

    const summary =
      await buildAdminSummary();


    await sendWhatsAppText(
      from,
      summary
    );


    await sendAdminExcelReport(
      from
    );


    return;
  }


  // =================================================
  // history قبل حفظ الرسالة الحالية
  // =================================================

  const history =
    await getConversationHistory(
      from,
      20
    );


  // =================================================
  // حفظ الرسالة
  //
  // الريكورد يتم حفظ النص الناتج منه.
  // =================================================

  await saveConversation(
    from,
    'user',
    incoming.type ===
      'audio'
      ? `[Voice] ${userText}`
      : userText
  );


  // =================================================
  // نظام المعاينة
  //
  // الريكورد يدخل نفس المسار بالضبط.
  // مثال:
  //
  // "أبغى أوقف عليها الأربعاء الساعة خمسة"
  //
  // =================================================

  const viewingResult =
    await processViewingFlow({
      customerPhone:
        from,

      userText,

      history,
    });


  if (
    viewingResult?.handled
  ) {

    await sendWhatsAppText(
      from,
      viewingResult.reply
    );


    await saveConversation(
      from,
      'assistant',
      viewingResult.reply
    );


    if (
      viewingResult.completed &&
      viewingResult.request
    ) {

      await saveViewingRequest(
        viewingResult.request
      );


      await notifyAdminsAboutViewing(
        viewingResult.request
      );
    }


    return;
  }


  // =================================================
  // AI reply
  // =================================================

  const reply =
    await generateReply(
      history,
      userText
    );


  if (!reply) {

    return;
  }


  // مهم:
  // الرد دائمًا Text.
  //
  // حتى لو رسالة العميل كانت Voice.
  // لا يوجد إرسال Audio هنا.

  await sendWhatsAppText(
    from,
    reply
  );


  await saveConversation(
    from,
    'assistant',
    reply
  );
}


// =====================================================
// Webhook POST
// =====================================================

app.post(
  '/webhook',
  async (req, res) => {

    // Meta يحتاج 200 بسرعة.
    // لذلك نرجع الرد أولًا.

    res.sendStatus(
      200
    );


    try {

      const body =
        req.body;


      if (
        body?.object !==
        'whatsapp_business_account'
      ) {

        return;
      }


      const entries =
        body.entry ||
        [];


      for (
        const entry
        of entries
      ) {

        const changes =
          entry.changes ||
          [];


        for (
          const change
          of changes
        ) {

          const value =
            change.value;


          const messages =
            value?.messages ||
            [];


          for (
            const message
            of messages
          ) {

            // Status updates لا تدخل هنا
            // لأنها ليست داخل messages.

            try {

              await processCustomerMessage(
                message
              );

            } catch (
              messageError
            ) {

              console.error(
                'Process customer message error:',
                messageError
              );
            }
          }
        }
      }

    } catch (err) {

      console.error(
        'Webhook processing error:',
        err
      );
    }
  }
);


// =====================================================
// الرسائل الجماعية (Broadcast)
// =====================================================

// تحويل الرقم السعودي للصيغة الدولية
// 0551234567  → 966551234567
// 551234567   → 966551234567
// +966551234567 / 00966551234567 → 966551234567

function normalizeSaudiPhone(
  phone
) {

  let digits =
    normalizePhone(
      phone
    );


  if (
    digits.startsWith('00')
  ) {

    digits =
      digits.slice(2);
  }


  if (
    digits.startsWith('05') &&
    digits.length === 10
  ) {

    digits =
      '966' + digits.slice(1);
  }


  if (
    digits.startsWith('5') &&
    digits.length === 9
  ) {

    digits =
      '966' + digits;
  }


  // رقم سعودي جوال صحيح: 9665 + 8 أرقام
  if (
    /^9665\d{8}$/.test(digits)
  ) {

    return digits;
  }


  // أرقام دولية أخرى (10 إلى 15 رقم)
  if (
    /^\d{10,15}$/.test(digits) &&
    !digits.startsWith('0')
  ) {

    return digits;
  }


  return null;
}


function isOptOutMessage(
  text
) {

  const value =
    String(
      text || ''
    )
      .trim()
      .toLowerCase();


  return [
    'إيقاف',
    'ايقاف',
    'أيقاف',
    'إلغاء',
    'الغاء',
    'stop',
    'unsubscribe',
  ].includes(
    value
  );
}


async function saveOptOut(
  customerPhone
) {

  try {

    await pool.query(
      `
      INSERT INTO opt_outs (customer_phone)
      VALUES ($1)
      ON CONFLICT (customer_phone) DO NOTHING
      `,
      [
        normalizePhone(
          customerPhone
        ),
      ]
    );

  } catch (err) {

    console.error(
      'Save opt-out error:',
      err
    );
  }
}


async function getOptedOutSet() {

  try {

    const result =
      await pool.query(
        'SELECT customer_phone FROM opt_outs'
      );


    return new Set(
      result.rows.map(
        (row) =>
          row.customer_phone
      )
    );

  } catch (err) {

    console.error(
      'Get opt-outs error:',
      err
    );


    return new Set();
  }
}


// إرسال قالب واتساب معتمد لرقم واحد

async function sendWhatsAppTemplate(
  to,
  customerName
) {

  if (
    !WHATSAPP_TOKEN ||
    !PHONE_NUMBER_ID
  ) {

    return {
      ok: false,
      error: 'WhatsApp credentials missing',
    };
  }


  try {

    const response =
      await axios.post(

        `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`,

        {
          messaging_product:
            'whatsapp',

          recipient_type:
            'individual',

          to,

          type:
            'template',

          template: {
            name:
              BROADCAST_TEMPLATE_NAME,

            language: {
              code:
                BROADCAST_TEMPLATE_LANG,
            },

            components: [
              {
                type:
                  'body',

                parameters: [
                  {
                    type:
                      'text',

                    text:
                      customerName,
                  },
                ],
              },
            ],
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


    return {
      ok: true,
      messageId:
        response.data?.messages?.[0]?.id ||
        null,
    };

  } catch (err) {

    const details =
      err.response?.data?.error;


    const errorText =
      details
        ? `${details.code || ''} ${details.message || ''} ${details.error_data?.details || ''}`.trim()
        : err.message;


    console.error(
      'WhatsApp send template error:',
      JSON.stringify(
        err.response?.data ||
          err.message,
        null,
        2
      )
    );


    return {
      ok: false,
      error: errorText,
    };
  }
}


// قراءة القائمة: كل سطر = رقم، وممكن بعده اسم
// أمثلة:
// 0551234567
// 0551234567, محمد
// 966551234567 - أحمد

function parseBroadcastList(
  rawText
) {

  const lines =
    String(
      rawText || ''
    )
      .split(/\r?\n/)
      .map(
        (line) =>
          line.trim()
      )
      .filter(Boolean);


  const valid = [];

  const invalid = [];

  const seen = new Set();


  for (
    const line
    of lines
  ) {

    const match =
      line.match(
        /^([+\d\s\-()]+?)\s*(?:[,،;\-|\t]\s*(.*))?$/
      );


    const phonePart =
      match
        ? match[1]
        : line;


    const namePart =
      match && match[2]
        ? match[2].trim()
        : '';


    const phone =
      normalizeSaudiPhone(
        phonePart
      );


    if (!phone) {

      invalid.push(
        line
      );

      continue;
    }


    if (
      seen.has(phone)
    ) {

      continue;
    }


    seen.add(
      phone
    );


    valid.push({
      phone,
      name:
        namePart.slice(0, 60) ||
        BROADCAST_DEFAULT_NAME,
    });
  }


  return {
    valid,
    invalid,
  };
}


function sleep(
  ms
) {

  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}


// حالة الإرسال الحالي (عشان الصفحة تعرض التقدم)

const broadcastState = {
  running: false,
  total: 0,
  sent: 0,
  failed: 0,
  skippedOptOut: 0,
  invalid: [],
  errors: [],
  startedAt: null,
  finishedAt: null,
};


async function runBroadcast(
  recipients
) {

  broadcastState.running = true;


  for (
    const recipient
    of recipients
  ) {

    const result =
      await sendWhatsAppTemplate(
        recipient.phone,
        recipient.name
      );


    try {

      await pool.query(
        `
        INSERT INTO broadcast_log
        (customer_phone, customer_name, template_name, status, error)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          recipient.phone,
          recipient.name,
          BROADCAST_TEMPLATE_NAME,
          result.ok ? 'sent' : 'failed',
          result.ok ? null : result.error,
        ]
      );

    } catch (err) {

      console.error(
        'Broadcast log error:',
        err
      );
    }


    if (
      result.ok
    ) {

      broadcastState.sent++;


      // نحفظ الرسالة في سجل المحادثة
      // عشان لما العميل يرد، البوت يعرف هو بيرد على إيه

      await saveConversation(
        recipient.phone,
        'assistant',
        BROADCAST_TEMPLATE_PREVIEW.replace(
          '{{1}}',
          recipient.name
        )
      );

    } else {

      broadcastState.failed++;


      if (
        broadcastState.errors.length < 50
      ) {

        broadcastState.errors.push(
          `${recipient.phone}: ${result.error}`
        );
      }
    }


    await sleep(
      BROADCAST_DELAY_MS
    );
  }


  broadcastState.running = false;

  broadcastState.finishedAt =
    new Date().toISOString();


  console.log(
    `Broadcast finished: sent ${broadcastState.sent}, failed ${broadcastState.failed}`
  );
}


function checkBroadcastPassword(
  req
) {

  const given =
    String(
      req.headers['x-broadcast-password'] ||
      ''
    );


  return (
    BROADCAST_PASSWORD.length >= 6 &&
    given === BROADCAST_PASSWORD
  );
}


// صفحة الإرسال

app.get(
  '/broadcast',
  (req, res) => {

    res
      .status(200)
      .type('html')
      .send(BROADCAST_PAGE_HTML);
  }
);


// بدء الإرسال

app.post(
  '/api/broadcast',
  async (req, res) => {

    if (
      !checkBroadcastPassword(
        req
      )
    ) {

      return res
        .status(401)
        .json({
          error:
            'كلمة السر غلط (أو لسه ما اتضافتش في Render)',
        });
    }


    if (
      broadcastState.running
    ) {

      return res
        .status(409)
        .json({
          error:
            'فيه إرسال شغال حاليًا، استنى لما يخلص',
        });
    }


    const {
      valid,
      invalid,
    } =
      parseBroadcastList(
        req.body?.numbers
      );


    const optedOut =
      await getOptedOutSet();


    const recipients =
      valid.filter(
        (r) =>
          !optedOut.has(
            r.phone
          )
      );


    const skippedOptOut =
      valid.length -
      recipients.length;


    if (
      !recipients.length
    ) {

      return res
        .status(400)
        .json({
          error:
            'مفيش أرقام صالحة للإرسال',
          invalid,
          skippedOptOut,
        });
    }


    if (
      recipients.length >
      BROADCAST_MAX_PER_RUN
    ) {

      return res
        .status(400)
        .json({
          error:
            `الحد الأقصى ${BROADCAST_MAX_PER_RUN} رقم في المرة الواحدة. القائمة فيها ${recipients.length}`,
        });
    }


    Object.assign(
      broadcastState,
      {
        running: true,
        total: recipients.length,
        sent: 0,
        failed: 0,
        skippedOptOut,
        invalid,
        errors: [],
        startedAt:
          new Date().toISOString(),
        finishedAt: null,
      }
    );


    // نشتغل في الخلفية ونرد على الصفحة فورًا

    runBroadcast(
      recipients
    ).catch(
      (err) => {

        console.error(
          'Broadcast run error:',
          err
        );

        broadcastState.running = false;
      }
    );


    return res.json({
      ok: true,
      state: broadcastState,
    });
  }
);


// متابعة حالة الإرسال

app.get(
  '/api/broadcast/status',
  (req, res) => {

    if (
      !checkBroadcastPassword(
        req
      )
    ) {

      return res
        .status(401)
        .json({
          error:
            'كلمة السر غلط',
        });
    }


    return res.json(
      broadcastState
    );
  }
);


const BROADCAST_PAGE_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>إرسال جماعي - سدين</title>
<style>
  body { font-family: Tahoma, Arial, sans-serif; background:#f4f1ea; margin:0; padding:20px; color:#222; }
  .box { max-width:640px; margin:0 auto; background:#fff; border-radius:14px; padding:24px; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  h1 { margin-top:0; font-size:22px; color:#7a5c1e; }
  label { display:block; margin:16px 0 6px; font-weight:bold; }
  input, textarea { width:100%; box-sizing:border-box; padding:10px; border:1px solid #ccc; border-radius:8px; font-size:16px; font-family:inherit; }
  textarea { min-height:220px; direction:ltr; text-align:right; }
  button { margin-top:18px; width:100%; padding:14px; font-size:18px; background:#7a5c1e; color:#fff; border:none; border-radius:10px; cursor:pointer; }
  button:disabled { background:#aaa; }
  .hint { color:#666; font-size:14px; }
  #status { margin-top:20px; white-space:pre-wrap; background:#faf7f0; padding:14px; border-radius:8px; display:none; line-height:1.8; }
</style>
</head>
<body>
<div class="box">
  <h1>📤 إرسال رسالة العروض لقائمة أرقام</h1>
  <p class="hint">القالب: <b>${BROADCAST_TEMPLATE_NAME}</b> — ابعت بس لعملاء موافقين يستقبلوا رسايل منك.</p>

  <label>كلمة السر</label>
  <input id="pw" type="password" autocomplete="off">

  <label>الأرقام (كل رقم في سطر، وممكن بعده فاصلة واسم العميل)</label>
  <textarea id="nums" placeholder="0551234567, محمد&#10;0559876543, أحمد&#10;0501112233"></textarea>
  <p class="hint">لو مكتبتش اسم، هيتكتب: ${BROADCAST_DEFAULT_NAME}</p>

  <button id="btn" onclick="startSend()">إرسال</button>

  <div id="status"></div>
</div>

<script>
  const statusBox = document.getElementById('status');
  const btn = document.getElementById('btn');
  let timer = null;

  function show(text) {
    statusBox.style.display = 'block';
    statusBox.textContent = text;
  }

  function render(s) {
    let t = s.running ? '⏳ جاري الإرسال...\\n\\n' : '✅ خلص الإرسال\\n\\n';
    t += 'الإجمالي: ' + s.total + '\\n';
    t += 'اتبعت: ' + s.sent + '\\n';
    t += 'فشل: ' + s.failed + '\\n';
    t += 'اتشال (طلبوا إيقاف): ' + s.skippedOptOut + '\\n';
    if (s.invalid && s.invalid.length) t += '\\nأرقام غلط اتجاهلت:\\n' + s.invalid.join('\\n') + '\\n';
    if (s.errors && s.errors.length) t += '\\nأخطاء:\\n' + s.errors.join('\\n');
    show(t);
  }

  async function poll() {
    try {
      const r = await fetch('/api/broadcast/status', { headers: { 'x-broadcast-password': document.getElementById('pw').value } });
      const s = await r.json();
      render(s);
      if (!s.running) { clearInterval(timer); btn.disabled = false; }
    } catch (e) {}
  }

  async function startSend() {
    const nums = document.getElementById('nums').value.trim();
    if (!nums) { show('اكتب الأرقام الأول'); return; }
    const count = nums.split('\\n').filter(l => l.trim()).length;
    if (!confirm('هتبعت الرسالة لـ ' + count + ' رقم. متأكد؟')) return;

    btn.disabled = true;
    show('⏳ بنبدأ...');
    try {
      const r = await fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-broadcast-password': document.getElementById('pw').value },
        body: JSON.stringify({ numbers: nums })
      });
      const data = await r.json();
      if (!r.ok) {
        let t = '❌ ' + (data.error || 'حصل خطأ');
        if (data.invalid && data.invalid.length) t += '\\n\\nأرقام غلط:\\n' + data.invalid.join('\\n');
        show(t);
        btn.disabled = false;
        return;
      }
      render(data.state);
      timer = setInterval(poll, 3000);
    } catch (e) {
      show('❌ مقدرتش أوصل للسيرفر: ' + e.message);
      btn.disabled = false;
    }
  }
</script>
</body>
</html>`;


// =====================================================
// 404
// =====================================================

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        error:
          'Not found',
      });
  }
);


// =====================================================
// تشغيل السيرفر
// =====================================================

async function startServer() {

  try {

    if (
      !DATABASE_URL
    ) {

      throw new Error(
        'DATABASE_URL is missing'
      );
    }


    await initializeDatabase();


    app.listen(
      PORT,
      () => {

        console.log(
          `Sadin AI Agent running on port ${PORT}`
        );


        console.log(
          'WhatsApp text: enabled'
        );


        console.log(
          `Voice transcription: ${
            OPENAI_API_KEY
              ? 'enabled'
              : 'disabled - OPENAI_API_KEY missing'
          }`
        );


        console.log(
          `Sticker understanding: ${
            OPENAI_API_KEY
              ? 'enabled'
              : 'disabled - OPENAI_API_KEY missing'
          }`
        );
      }
    );

  } catch (err) {

    console.error(
      'Server startup error:',
      err
    );


    process.exit(1);
  }
}


startServer();
