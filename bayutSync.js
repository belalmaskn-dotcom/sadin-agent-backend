const axios = require("axios");
const cheerio = require("cheerio");

const TEST_BAYUT_ID = "88101834";

function clean(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

async function fetchBayutProperty(bayutId) {
  const url = `https://www.bayut.sa/العقار/تفاصيل-${bayutId}.html`;

  console.log(`\n🏠 Reading Bayut property: ${bayutId}`);
  console.log(`🔗 ${url}\n`);

  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
      "Accept-Language": "ar-SA,ar;q=0.9,en;q=0.8",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const $ = cheerio.load(response.data);

  const pageText = clean($("body").text());

  const title = clean($("h1").first().text());

  function match(pattern) {
    const result = pageText.match(pattern);
    return result ? clean(result[1]) : null;
  }

  const property = {
    bayut_id: bayutId,

    url,

    title,

    price:
      match(/السعر\s+([\d,.]+)/) ||
      match(/([\d,.]+)\s*ريال سعودي/),

    property_type:
      match(/نوع العقار\s+(.+?)\s+نوع العرض/),

    purpose:
      match(/نوع العرض\s+(.+?)\s+رقم بيوت المرجعي/),

    residence_type:
      match(/نوع السكن\s+(.+?)\s+حالة البناء/),

    construction_status:
      match(/حالة البناء\s+(.+?)\s+التأثيث/),

    furnished:
      match(/التأثيث\s+(.+?)\s+تاريخ الإضافة/),

    property_age:
      match(/عمر العقار\s+(.+?)\s+(?:المزايا والخدمات|عرض الشارع)/),

    region:
      match(/المنطقة\s+(.+?)\s+المدينة/),

    city:
      match(/المدينة\s+(.+?)\s+الحي/),

    district:
      match(/الحي\s+(.+?)\s+اسم الشارع/),

    street:
      match(/اسم الشارع\s+(.+?)\s+الرمز البريدي/),

    postal_code:
      match(/الرمز البريدي\s+(\d+)/),

    building_number:
      match(/رقم المبنى\s+(\d+)/),

    latitude:
      match(/خط العرض\s+([\d.]+)/),

    longitude:
      match(/خط الطول\s+([\d.]+)/),

    official_price:
      match(/تفاصيل العقار\s+نوع الإعلان.+?السعر\s+([\d,.]+)/),

    area:
      match(/المساحة\s+([\d.]+)/),

    rooms:
      match(/عدد الغرف\s+(\d+)/),

    street_width:
      match(/عرض الشارع\s+([\d.]+)/),

    plan_number:
      match(/رقم المخطط\s+(.+?)\s+رقم صك الملكية/),

    land_number:
      match(/رقم الأرض\s+(.+?)\s+ملاحظات/),

    deed_number:
      match(/رقم صك الملكية\s+(.+?)\s+واجهة العقار/),

    facade:
      match(/واجهة العقار\s*(.*?)\s+حدود واطوال العقار/),

    mortgage:
      match(/العقار مرهون\s+(.+?)\s+العقار مقيد/),

    notes:
      match(/ملاحظات\s*(.+?)\s+حدود العقار\/الملكية/),

    fal_license:
      match(/رقم رخصة فال\s+(\d+)/),
  };

  console.log("====================================");
  console.log("✅ BAYUT PROPERTY READ SUCCESSFULLY");
  console.log("====================================");

  console.log(JSON.stringify(property, null, 2));

  return property;
}

async function main() {
  try {
    await fetchBayutProperty(TEST_BAYUT_ID);

    console.log("\n✅ Test completed.");
  } catch (error) {
    console.error("\n❌ Bayut test failed.");

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Status Text:", error.response.statusText);
    } else {
      console.error(error.message);
    }

    process.exitCode = 1;
  }
}

main();

module.exports = {
  fetchBayutProperty,
