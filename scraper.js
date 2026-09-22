// scraper.js — يزحف على صفحات العقارات العامة في sadin.com.sa
// ويستخرج بيانات كل عقار ويخزّنها محليًا عبر db.js
//
// ملاحظة مهمة: الـ selectors هنا مبنية على شكل النص الظاهر في الصفحة،
// مش على أسماء كلاسات CSS فعلية (محتاجين نشوف الكود المصدري الحقيقي
// عشان نظبطها 100%). لو الاستخراج طلع ناقص لحقل معيّن، ابعتلي HTML
// صفحة /properties (View Source) وهظبطها بالظبط.

const axios = require('axios');
const cheerio = require('cheerio');
const { upsertProperty, countProperties } = require('./db');

const BASE_URL = 'https://sadin.com.sa';
const PURPOSES = ['sale', 'rent', 'requested', 'auction'];
const MAX_PAGES_SAFETY = 150; // حد أمان عشان السكريبت ميفضلش يلف لو حصل خطأ
const DELAY_MS = 600; // تأخير بسيط بين الطلبات، احترامًا لسيرفر الموقع

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCardText(text, href) {
  const codeMatch = href.match(/\/property\/([A-Za-z0-9]+)/);
  if (!codeMatch) return null;
  const code = codeMatch[1];

  const cityDistrictMatch = text.match(/([\u0600-\u06FF\s]+?)\s*·\s*([\u0600-\u06FF\s()]+)/);
  const typeMatch = text.match(/^([\u0600-\u06FF\s]+?)رقم\s*[A-Za-z0-9]+/);
  const areaMatch = text.match(/([\d,.]+)\s*م²/);
  const roomsMatch = text.match(/(\d+)\s*غرف/);
  const bathroomsMatch = text.match(/(\d+)\s*حمام/);
  const purposeMatch = text.includes('للإيجار') ? 'rent'
    : text.includes('للبيع') ? 'sale'
    : text.includes('مزاد') ? 'auction'
    : text.includes('مطلوب') ? 'requested' : null;
  const licenseStatus = text.includes('تم البيع') ? 'تم البيع'
    : text.includes('ترخيص ساري') ? 'ترخيص ساري' : null;

  // العنوان: أول جملة عربية طويلة نسبيًا قبل "رقم"
  const titleMatch = text.match(/([\u0600-\u06FF][\u0600-\u06FF\s\-–|()0-9]{10,120}?)\s*رقم\s*[A-Za-z0-9]+/);

  return {
    code,
    title: titleMatch ? titleMatch[1].trim() : null,
    purpose: purposeMatch,
    property_type: typeMatch ? typeMatch[1].trim() : null,
    city: cityDistrictMatch ? cityDistrictMatch[1].trim() : null,
    district: cityDistrictMatch ? cityDistrictMatch[2].trim() : null,
    area_sqm: areaMatch ? parseFloat(areaMatch[1].replace(/,/g, '')) : null,
    rooms: roomsMatch ? parseInt(roomsMatch[1], 10) : null,
    bathrooms: bathroomsMatch ? parseInt(bathroomsMatch[1], 10) : null,
    price: null, // بيتحدّث لاحقًا عبر enrichPrice لو احتجت السعر
    license_status: licenseStatus,
    url: `${BASE_URL}/property/${code}`,
  };
}

async function fetchPage(purpose, page) {
  const url = `${BASE_URL}/properties?purpose=${purpose}&page=${page}`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SadinIndexBot/1.0)' },
    timeout: 15000,
  });
  return res.data;
}

async function scrapeAll() {
  let totalFound = 0;

  for (const purpose of PURPOSES) {
    console.log(`\n== جاري فهرسة عقارات: ${purpose} ==`);

    for (let page = 1; page <= MAX_PAGES_SAFETY; page++) {
      let html;
      try {
        html = await fetchPage(purpose, page);
      } catch (err) {
        console.log(`  توقف عند صفحة ${page} (${err.message})`);
        break;
      }

      const $ = cheerio.load(html);
      const links = $('a[href*="/property/"]').toArray();

      if (links.length === 0) {
        console.log(`  انتهت الصفحات عند صفحة ${page}`);
        break;
      }

      const seenCodes = new Set();
      let pageCount = 0;

      for (const el of links) {
        const href = $(el).attr('href');
        if (!href) continue;
        const codeMatch = href.match(/\/property\/([A-Za-z0-9]+)/);
        if (!codeMatch) continue;
        const code = codeMatch[1];
        if (seenCodes.has(code)) continue;
        seenCodes.add(code);

        // ناخد نص أوسع حوالين الرابط (الكارت كامل) عشان نلاقي كل التفاصيل
        let cardText = $(el).closest('article, li, div').text();
        if (!cardText || cardText.length < 20) {
          cardText = $(el).parent().parent().parent().text();
        }

        const parsed = parseCardText(cardText, href);
        if (parsed) {
          if (!parsed.purpose) parsed.purpose = purpose;
          upsertProperty(parsed);
          pageCount++;
        }
      }

      console.log(`  صفحة ${page}: ${pageCount} عقار`);
      totalFound += pageCount;

      if (pageCount === 0) break;
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nتم الانتهاء. إجمالي العقارات في الفهرس: ${countProperties()}`);
  return totalFound;
}

if (require.main === module) {
  scrapeAll().catch((err) => {
    console.error('خطأ عام في الزحف:', err);
    process.exit(1);
  });
}

module.exports = { scrapeAll };
