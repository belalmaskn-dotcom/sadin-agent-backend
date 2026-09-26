require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL غير موجود");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL.includes("localhost") ||
    process.env.DATABASE_URL.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
});

function clean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return value;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);

  if (number === null) {
    return null;
  }

  return Math.round(number);
}

function jsonValue(value, fallback = []) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

async function createTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bayut_properties (
      bayut_id BIGINT PRIMARY KEY,

      rega_license VARCHAR(100),

      status VARCHAR(100),

      purpose VARCHAR(100),
      purpose_ar VARCHAR(100),

      property_type VARCHAR(150),
      property_type_ar VARCHAR(150),

      title TEXT,
      title_ar TEXT,

      description TEXT,
      description_ar TEXT,

      price NUMERIC(15,2),
      area NUMERIC(15,2),

      rooms INTEGER,

      beds VARCHAR(100),
      baths VARCHAR(100),

      city VARCHAR(200),
      district VARCHAR(200),
      street VARCHAR(300),

      street_width NUMERIC(10,2),

      property_face VARCHAR(200),
      property_age VARCHAR(100),

      furnished VARCHAR(100),
      residence_type VARCHAR(100),
      completion_status VARCHAR(100),

      plan_number VARCHAR(200),
      land_number VARCHAR(200),
      deed_number VARCHAR(200),

      notes TEXT,

      features JSONB DEFAULT '[]'::jsonb,

      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,

      bayut_url TEXT,
      rega_url TEXT,

      posted_at TIMESTAMPTZ,
      bayut_updated_at TIMESTAMPTZ,
      expiry_date DATE,

      images JSONB DEFAULT '[]'::jsonb,

      is_active BOOLEAN DEFAULT TRUE,

      synced_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_status
    ON bayut_properties(status);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_purpose
    ON bayut_properties(purpose_ar);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_type
    ON bayut_properties(property_type_ar);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_city
    ON bayut_properties(city);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_district
    ON bayut_properties(district);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_price
    ON bayut_properties(price);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_rooms
    ON bayut_properties(rooms);
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bayut_properties_area
    ON bayut_properties(area);
  `);
}

async function importProperties(client, properties) {
  const sql = `
    INSERT INTO bayut_properties (
      bayut_id,
      rega_license,
      status,
      purpose,
      purpose_ar,
      property_type,
      property_type_ar,
      title,
      title_ar,
      description,
      description_ar,
      price,
      area,
      rooms,
      beds,
      baths,
      city,
      district,
      street,
      street_width,
      property_face,
      property_age,
      furnished,
      residence_type,
      completion_status,
      plan_number,
      land_number,
      deed_number,
      notes,
      features,
      latitude,
      longitude,
      bayut_url,
      rega_url,
      posted_at,
      bayut_updated_at,
      expiry_date,
      images,
      is_active,
      synced_at,
      updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
      $31,$32,$33,$34,$35,$36,$37,$38,$39,NOW(),NOW()
    )

    ON CONFLICT (bayut_id)
    DO UPDATE SET
      rega_license = EXCLUDED.rega_license,
      status = EXCLUDED.status,
      purpose = EXCLUDED.purpose,
      purpose_ar = EXCLUDED.purpose_ar,
      property_type = EXCLUDED.property_type,
      property_type_ar = EXCLUDED.property_type_ar,
      title = EXCLUDED.title,
      title_ar = EXCLUDED.title_ar,
      description = EXCLUDED.description,
      description_ar = EXCLUDED.description_ar,
      price = EXCLUDED.price,
      area = EXCLUDED.area,
      rooms = EXCLUDED.rooms,
      beds = EXCLUDED.beds,
      baths = EXCLUDED.baths,
      city = EXCLUDED.city,
      district = EXCLUDED.district,
      street = EXCLUDED.street,
      street_width = EXCLUDED.street_width,
      property_face = EXCLUDED.property_face,
      property_age = EXCLUDED.property_age,
      furnished = EXCLUDED.furnished,
      residence_type = EXCLUDED.residence_type,
      completion_status = EXCLUDED.completion_status,
      plan_number = EXCLUDED.plan_number,
      land_number = EXCLUDED.land_number,
      deed_number = EXCLUDED.deed_number,
      notes = EXCLUDED.notes,
      features = EXCLUDED.features,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      bayut_url = EXCLUDED.bayut_url,
      rega_url = EXCLUDED.rega_url,
      posted_at = EXCLUDED.posted_at,
      bayut_updated_at = EXCLUDED.bayut_updated_at,
      expiry_date = EXCLUDED.expiry_date,
      images = EXCLUDED.images,
      is_active = EXCLUDED.is_active,
      synced_at = NOW(),
      updated_at = NOW()
  `;

  let success = 0;
  let failed = 0;

  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];

    try {
      const bayutId = integerOrNull(property.bayut_id);

      if (!bayutId) {
        throw new Error("bayut_id غير صالح");
      }

      const status = clean(property.status) || "Active";

      const active =
        String(status).toLowerCase() === "active" ||
        String(status).toLowerCase() === "live";

      const values = [
        bayutId,
        clean(property.rega_license),
        status,

        clean(property.purpose),
        clean(property.purpose_ar),

        clean(property.property_type),
        clean(property.property_type_ar),

        clean(property.title),
        clean(property.title_ar),

        clean(property.description),
        clean(property.description_ar),

        numberOrNull(property.price),
        numberOrNull(property.area),

        integerOrNull(property.rooms),

        clean(property.beds),
        clean(property.baths),

        clean(property.city),
        clean(property.district),
        clean(property.street),

        numberOrNull(property.street_width),

        clean(property.property_face),
        clean(property.property_age),

        clean(property.furnished),
        clean(property.residence_type),
        clean(property.completion_status),

        clean(property.plan_number),
        clean(property.land_number),
        clean(property.deed_number),

        clean(property.notes),

        jsonValue(property.features),

        numberOrNull(property.latitude),
        numberOrNull(property.longitude),

        clean(property.bayut_url),
        clean(property.rega_url),

        clean(property.posted_at),
        clean(property.updated_at),
        clean(property.expiry_date),

        jsonValue(property.images),

        active,
      ];

      await client.query(sql, values);

      success++;

      console.log(
        `✅ ${i + 1}/${properties.length} | ${bayutId} | ${
          property.property_type_ar || property.property_type || "عقار"
        } | ${property.district || ""}`
      );
    } catch (error) {
      failed++;

      console.error(
        `❌ ${i + 1}/${properties.length} | ${
          property.bayut_id || "بدون ID"
        } | ${error.message}`
      );
    }
  }

  return { success, failed };
}

async function verifyImport(client) {
  const result = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active,
      COUNT(*) FILTER (WHERE purpose_ar = 'بيع')::int AS sale,
      COUNT(*) FILTER (WHERE purpose_ar = 'إيجار')::int AS rent
    FROM bayut_properties;
  `);

  return result.rows[0];
}

async function main() {
  const jsonPath = path.join(__dirname, "bayut-properties.json");

  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      "ملف bayut-properties.json غير موجود في نفس مجلد المشروع"
    );
  }

  const file = fs.readFileSync(jsonPath, "utf8");

  let properties;

  try {
    properties = JSON.parse(file);
  } catch {
    throw new Error("ملف bayut-properties.json ليس JSON صالح");
  }

  if (!Array.isArray(properties)) {
    throw new Error(
      "المحتوى داخل bayut-properties.json لازم يكون Array"
    );
  }

  console.log("========================================");
  console.log("🏠 SADIN — Bayut Properties Import");
  console.log("========================================");
  console.log(`📦 عدد العقارات في الملف: ${properties.length}`);

  const client = await pool.connect();

  try {
    console.log("🗄️ إنشاء/فحص جدول bayut_properties...");

    await createTable(client);

    console.log("✅ الجدول جاهز");
    console.log("📥 بدء الاستيراد...");

    const result = await importProperties(client, properties);

    const stats = await verifyImport(client);

    console.log("");
    console.log("========================================");
    console.log("✅ انتهى الاستيراد");
    console.log(`نجح: ${result.success}`);
    console.log(`فشل: ${result.failed}`);
    console.log("----------------------------------------");
    console.log(`إجمالي العقارات في DB: ${stats.total}`);
    console.log(`النشطة: ${stats.active}`);
    console.log(`للبيع: ${stats.sale}`);
    console.log(`للإيجار: ${stats.rent}`);
    console.log("========================================");
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error("");
    console.error("❌ Import failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
