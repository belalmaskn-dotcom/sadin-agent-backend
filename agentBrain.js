// agentBrain.js — عقل الـ Agent: بيكلّم Claude، يستخرج معايير الطلب،
// ويتأكد من الفهرس المحلي قبل ما يرد على العميل بأي حاجة عن توفر عقار
const axios = require('axios');
const { searchProperties } = require('./search');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';

const EXTRACTION_SYSTEM_PROMPT = `أنت مساعد عقاري ذكي بترد على عملاء تواصلوا عبر واتساب مع مكتب عقاري في السعودية.

تكلم مع العميل بشكل طبيعي وودود ومختصر.

لو العميل قال تحية أو كلام عادي مثل:
السلام عليكم، هلا، ازيك، كيفك، صباح الخير، مساء الخير
رد عليه بشكل طبيعي وودود ولا تبدأ مباشرة في سؤاله عن العقارات.

مثال:
لو قال "ازيك" رد عليه مثل:
"الحمدلله بخير، الله يسعدك 🌹 كيف أقدر أخدمك؟"

لو العميل سأل عن شيء لا تعرف إجابته أو لا توجد عندك معلومات مؤكدة عنه، لا تخترع إجابة وقل له:
"تقدر تتواصل معنا على الرقم 0530084666 وراح يفيدونك بالتفاصيل 🌹"

إذا كان العميل يبحث عن عقار، اجمع منه تدريجيًا:
- نوع العقار (شقة/فيلا/أرض/تجاري)
- الغرض (شراء/إيجار)
- المدينة والحي
- الميزانية التقريبية (اختياري)

ارجع دايمًا JSON فقط بدون أي نص خارجه، بالشكل ده:
{
  "reply": "ردك على العميل",
  "criteria": {
    "property_type": "قيمة أو null",
    "purpose": "sale أو rent أو null",
    "city": "قيمة أو null",
    "district": "قيمة أو null"
  },
  "ready_to_search": true أو false
}

لو الرسالة تحية أو كلام عادي خلي ready_to_search=false.

لو السؤال عن شيء لا تعرفه خلي ready_to_search=false واكتب رقم التواصل في reply.

"ready_to_search" يبقى true بس لما يكون عندك على الأقل نوع العقار + (مدينة أو حي).

لو ready_to_search=true، سيب "reply" مختصرة زي "أبشر، خليني أشوف لك المتاح 👌" لأننا هنستبدلها برد فيه نتايج حقيقية.`;

const GROUNDED_REPLY_SYSTEM_PROMPT = `أنت مساعد عقاري بترد على عميل واتساب. عندك نتايج بحث حقيقية من قاعدة بيانات
العقارات المتاحة فعليًا. اكتب رد طبيعي ودود للعميل بناءً على النتايج دي فقط —
لو مفيش نتايج، قوله بصراحة إنه مفيش المطابق دلوقتي واسأله لو حابب يوسّع البحث
أو يسيب بياناته عشان يتواصل معاه فريق المبيعات أول ما يتوفر حاجة مناسبة.
لا تخترع أي عقار مش موجود في النتايج. رجّع نص عادي (مش JSON) — ده الرد النهائي اللي هيتبعت للعميل.`;

async function callClaude(system, messages, maxTokens = 700) {
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: MODEL, max_tokens: maxTokens, system, messages },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      }
    );
    return res.data.content.map((b) => b.text || '').join('');
  } catch (err) {
console.error('تفاصيل خطأ Claude API:', JSON.stringify(err.response?.data || err.message, null, 2));
    throw err;
  }
}
async function generateReply(history, userText) {
  const messages = [...history, { role: 'user', content: userText }];

  const rawExtraction = await callClaude(EXTRACTION_SYSTEM_PROMPT, messages);
  const cleaned = rawExtraction.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return 'معلش حصل خلل بسيط، ممكن تعيد كلامك؟';
  }

  if (!parsed.ready_to_search) {
    return parsed.reply;
  }

  const matches = searchProperties({
    city: parsed.criteria.city,
    district: parsed.criteria.district,
    property_type: parsed.criteria.property_type,
    purpose: parsed.criteria.purpose,
    limit: 5,
  });

  const resultsContext = matches.length
    ? `نتايج البحث المتاحة فعليًا:\n${matches
        .map((m) => `- ${m.title || m.property_type} في ${m.city || ''} ${m.district || ''} — ${m.area_sqm || '؟'} م² — ${m.url}`)
        .join('\n')}`
    : 'مفيش نتايج مطابقة حاليًا في الفهرس.';

  const groundedMessages = [
    ...messages,
    { role: 'assistant', content: rawExtraction },
    { role: 'user', content: `[نتايج البحث الداخلية]\n${resultsContext}\n\nاكتب الرد النهائي للعميل بناءً على النتايج دي.` },
  ];

  const finalReply = await callClaude(GROUNDED_REPLY_SYSTEM_PROMPT, groundedMessages);
  return finalReply.trim();
}

module.exports = { generateReply };
