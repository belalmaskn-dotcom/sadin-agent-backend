const axios = require("axios");
const cheerio = require("cheerio");

// ==========================================
// BAYUT SYNC - SADIN REAL ESTATE
// ==========================================

// إعلان واحد فقط للاختبار الأول
const TEST_BAYUT_ID = "88101834";

// تنظيف النصوص
function clean(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .trim();
}

// البحث داخل نص الصفحة
function findValue(pageText, patterns) {
  for (const pattern of patterns) {
    const match = pageText.match(pattern);

    if (match && match[1]) {
      return clean(match[1]);
    }
  }

  return null;
}

// ==========================================
// قراءة عقار واحد من Bayut
// ==========================================

async function fetchBayutProperty(bayutId) {
  const url = `https://www.bayut.sa/العقار/تفاصيل-${bayutId}.html`;

  console.log("");
  console.log("======================================");
  console.log("🏠 Reading Bayut property");
  console.log("Bayut ID:", bayutId);
  console.log("URL:", url);
  console.log("======================================");
  console.log("");

  const response = await axios.get(url, {
    timeout: 30000,

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",

      "Accept-Language":
        "ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7",

      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

      "Cache-Control": "no-cache",

      Pragma: "no-cache",
    },
  });

  console.log("HTTP Status:", response.status);

  const $ = cheerio.load(response.data);

  const pageText = clean($("body").text());

  const title = clean($("h1").first().text());

  // ==========================================
  // استخراج البيانات
  // ==========================================

  const property = {
    bayut_id: bayutId,

    url: url,

    title: title || null,

    price: findValue(pageText, [
      /السعر\s*([\d,.]+)/i,
      /([\d,.]+)\s*ريال/i,
    ]),

    property_type: findValue(pageText, [
      /نوع العقار\s*(.+?)\s*نوع العرض/i,
      /نوع العقار\s*(.+?)\s*الغرض/i,
    ]),

    purpose: findValue(pageText, [
      /نوع العرض\s*(.+?)\s*رقم بيوت/i,
      /الغرض\s*(.+?)\s*نوع/i,
    ]),

    residence_type: findValue(pageText, [
      /نوع السكن\s*(.+?)\s*حالة البناء/i,
    ]),

    construction_status: findValue(pageText, [
      /حالة البناء\s*(.+?)\s*التأثيث/i,
    ]),

    furnished: findValue(pageText, [
      /التأثيث\s*(.+?)\s*تاريخ/i,
    ]),

    property_age: findValue(pageText, [
      /عمر العقار\s*(.+?)\s*عرض الشارع/i,
      /عمر العقار\s*(.+?)\s*المزايا/i,
    ]),

    region: findValue(pageText, [
      /المنطقة\s*(.+?)\s*المدينة/i,
    ]),

    city: findValue(pageText, [
      /المدينة\s*(.+?)\s*الحي/i,
    ]),

    district: findValue(pageText, [
      /الحي\s*(.+?)\s*اسم الشارع/i,
    ]),

    street: findValue(pageText, [
      /اسم الشارع\s*(.+?)\s*الرمز البريدي/i,
    ]),

    postal_code: findValue(pageText, [
      /الرمز البريدي\s*(\d+)/i,
    ]),

    building_number: findValue(pageText, [
      /رقم المبنى\s*(\d+)/i,
    ]),

    area: findValue(pageText, [
      /المساحة\s*([\d,.]+)/i,
      /([\d,.]+)\s*م²/i,
      /([\d,.]+)\s*متر مربع/i,
    ]),

    rooms: findValue(pageText, [
      /عدد الغرف\s*(\d+)/i,
      /الغرف\s*(\d+)/i,
    ]),

    bathrooms: findValue(pageText, [
      /عدد دورات المياه\s*(\d+)/i,
      /دورات المياه\s*(\d+)/i,
      /الحمامات\s*(\d+)/i,
    ]),

    street_width: findValue(pageText, [
      /عرض الشارع\s*([\d,.]+)/i,
    ]),

    plan_number: findValue(pageText, [
      /رقم المخطط\s*(.+?)\s*رقم/i,
    ]),

    land_number: findValue(pageText, [
      /رقم الأرض\s*(.+?)\s*ملاحظات/i,
    ]),

    deed_number: findValue(pageText, [
      /رقم صك الملكية\s*(.+?)\s*واجهة العقار/i,
    ]),

    facade: findValue(pageText, [
      /واجهة العقار\s*(.+?)\s*حدود/i,
    ]),

    rega_license: findValue(pageText, [
      /رقم ترخيص الإعلان\s*(\d+)/i,
      /رقم رخصة الإعلان\s*(\d+)/i,
      /REGA\s*(?:Ad\s*)?License\s*(?:Number)?\s*:?\s*(\d+)/i,
    ]),

    fal_license: findValue(pageText, [
      /رقم رخصة فال\s*(\d+)/i,
    ]),
  };

  // ==========================================
  // النتيجة
  // ==========================================

  console.log("");
  console.log("======================================");
  console.log("✅ BAYUT PROPERTY RESULT");
  console.log("======================================");

  console.log(JSON.stringify(property, null, 2));

  console.log("");
  console.log("======================================");

  return property;
}

// ==========================================
// تشغيل الاختبار
// ==========================================

async function main() {
  try {
    const property = await fetchBayutProperty(
      TEST_BAYUT_ID
    );

    if (!property) {
      throw new Error(
        "No property data returned."
      );
    }

    console.log("");
    console.log("✅ Test completed successfully.");
    console.log("");
  } catch (error) {
    console.error("");
    console.error("❌ Bayut test failed.");

    if (error.response) {
      console.error(
        "HTTP Status:",
        error.response.status
      );

      console.error(
        "Status Text:",
        error.response.statusText
      );
    }

    console.error(
      "Error:",
      error.message
    );

    console.error("");

    process.exitCode = 1;
  }
}

// تشغيل الملف فقط لو تم تشغيله مباشرة
if (require.main === module) {
  main();
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  fetchBayutProperty,
};
