// search.js
// البحث في عقارات سدّين المخزنة في PostgreSQL

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL غير موجود');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('localhost') &&
    !process.env.DATABASE_URL.includes('127.0.0.1')
      ? { rejectUnauthorized: false }
      : false,
});


// =====================================================
// تنظيف النص العربي
// =====================================================

function normalizeArabicText(text = '') {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


// =====================================================
// تحويل الغرض
// =====================================================

function normalizePurpose(purpose = '') {
  const p = normalizeArabicText(purpose);

  if (
    p === 'sale' ||
    p === 'for sale' ||
    p === 'بيع' ||
    p === 'للبيع' ||
    p === 'شراء'
  ) {
    return 'بيع';
  }

  if (
    p === 'rent' ||
    p === 'for rent' ||
    p === 'ايجار' ||
    p === 'إيجار' ||
    p === 'للايجار' ||
    p === 'للإيجار'
  ) {
    return 'إيجار';
  }

  return purpose || null;
}


// =====================================================
// تحويل نوع العقار
// =====================================================

function getPropertyTypeVariants(type = '') {
  const t = normalizeArabicText(type);

  if (!t) {
    return [];
  }

  const groups = [
    ['شقه', 'شقة', 'apartment', 'apartments'],
    ['فيلا', 'فله', 'villa', 'villas'],
    ['ارض', 'أرض', 'land', 'residential land'],
    ['عماره', 'عمارة', 'building', 'residential building'],
    ['مبنى', 'مبني', 'building'],
    ['استراحه', 'استراحة', 'rest house'],
    ['مكتب', 'office'],
    ['معرض', 'showroom', 'exhibition'],
    ['محل', 'shop'],
    ['مستودع', 'warehouse'],
    ['مزرعه', 'مزرعة', 'farm'],
  ];

  for (const group of groups) {
    if (
      group.some((item) =>
        t.includes(normalizeArabicText(item))
      )
    ) {
      return group;
    }
  }

  return [type];
}


// =====================================================
// البحث
// =====================================================

async function searchProperties(criteria = {}) {
  const clauses = [
    'is_active = TRUE'
  ];

  const values = [];

  function addValue(value) {
    values.push(value);
    return `$${values.length}`;
  }


  // ---------------------------------------------------
  // المدينة
  // ---------------------------------------------------

  if (criteria.city) {
    const value = addValue(
      `%${normalizeArabicText(criteria.city)}%`
    );

    clauses.push(`
      (
        LOWER(
          TRANSLATE(
            COALESCE(city, ''),
            'أإآى',
            'اااي'
          )
        ) LIKE ${value}
      )
    `);
  }


  // ---------------------------------------------------
  // الحي
  // ---------------------------------------------------

  if (criteria.district) {
    const value = addValue(
      `%${normalizeArabicText(criteria.district)
        .replace(/^حي\s+/, '')}%`
    );

    clauses.push(`
      (
        LOWER(
          TRANSLATE(
            COALESCE(district, ''),
            'أإآى',
            'اااي'
          )
        ) LIKE ${value}
      )
    `);
  }


  // ---------------------------------------------------
  // نوع العقار
  // ---------------------------------------------------

  if (criteria.property_type) {
    const variants =
      getPropertyTypeVariants(
        criteria.property_type
      );

    if (variants.length) {
      const typeClauses = [];

      for (const variant of variants) {
        const value = addValue(
          `%${normalizeArabicText(variant)}%`
        );

        typeClauses.push(`
          (
            LOWER(
              TRANSLATE(
                COALESCE(property_type_ar, ''),
                'أإآى',
                'اااي'
              )
            ) LIKE ${value}

            OR

            LOWER(
              COALESCE(property_type, '')
            ) LIKE ${value}
          )
        `);
      }

      clauses.push(
        `(${typeClauses.join(' OR ')})`
      );
    }
  }


  // ---------------------------------------------------
  // بيع / إيجار
  // ---------------------------------------------------

  if (criteria.purpose) {
    const purpose =
      normalizePurpose(
        criteria.purpose
      );

    const value =
      addValue(purpose);

    clauses.push(`
      purpose_ar = ${value}
    `);
  }


  // ---------------------------------------------------
  // السعر
  // ---------------------------------------------------

  if (
    criteria.min_price !== undefined &&
    criteria.min_price !== null &&
    criteria.min_price !== ''
  ) {
    const value =
      addValue(
        Number(criteria.min_price)
      );

    clauses.push(`
      price >= ${value}
    `);
  }


  if (
    criteria.max_price !== undefined &&
    criteria.max_price !== null &&
    criteria.max_price !== ''
  ) {
    const value =
      addValue(
        Number(criteria.max_price)
      );

    clauses.push(`
      price <= ${value}
    `);
  }


  // ---------------------------------------------------
  // المساحة
  // ---------------------------------------------------

  if (
    criteria.min_area !== undefined &&
    criteria.min_area !== null &&
    criteria.min_area !== ''
  ) {
    const value =
      addValue(
        Number(criteria.min_area)
      );

    clauses.push(`
      area >= ${value}
    `);
  }


  if (
    criteria.max_area !== undefined &&
    criteria.max_area !== null &&
    criteria.max_area !== ''
  ) {
    const value =
      addValue(
        Number(criteria.max_area)
      );

    clauses.push(`
      area <= ${value}
    `);
  }


  // ---------------------------------------------------
  // عدد الغرف
  // ---------------------------------------------------

  if (
    criteria.min_rooms !== undefined &&
    criteria.min_rooms !== null &&
    criteria.min_rooms !== ''
  ) {
    const value =
      addValue(
        Number(criteria.min_rooms)
      );

    clauses.push(`
      rooms >= ${value}
    `);
  }


  if (
    criteria.max_rooms !== undefined &&
    criteria.max_rooms !== null &&
    criteria.max_rooms !== ''
  ) {
    const value =
      addValue(
        Number(criteria.max_rooms)
      );

    clauses.push(`
      rooms <= ${value}
    `);
  }


  if (
    criteria.rooms !== undefined &&
    criteria.rooms !== null &&
    criteria.rooms !== ''
  ) {
    const value =
      addValue(
        Number(criteria.rooms)
      );

    clauses.push(`
      rooms = ${value}
    `);
  }


  // ---------------------------------------------------
  // الحد الأقصى للنتائج
  // ---------------------------------------------------

  let limit =
    Number(criteria.limit) || 5;

  if (limit < 1) {
    limit = 1;
  }

  if (limit > 20) {
    limit = 20;
  }

  const limitValue =
    addValue(limit);


  // ---------------------------------------------------
  // الاستعلام
  // ---------------------------------------------------

  const sql = `
    SELECT
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

      images

    FROM bayut_properties

    WHERE
      ${clauses.join('\nAND ')}

    ORDER BY
      CASE
        WHEN bayut_updated_at IS NULL
        THEN 1
        ELSE 0
      END,

      bayut_updated_at DESC,

      updated_at DESC

    LIMIT ${limitValue};
  `;


  try {
    const result =
      await pool.query(
        sql,
        values
      );

    return result.rows;

  } catch (error) {
    console.error(
      '❌ خطأ البحث في bayut_properties:',
      error
    );

    throw error;
  }
}


// =====================================================
// جلب عقار محدد برقم Bayut
// =====================================================

async function getPropertyByBayutId(
  bayutId
) {
  if (!bayutId) {
    return null;
  }

  const result =
    await pool.query(
      `
        SELECT *
        FROM bayut_properties
        WHERE bayut_id = $1
        LIMIT 1
      `,
      [bayutId]
    );

  return result.rows[0] || null;
}


// =====================================================
// اختبار مباشر
//
// node search.js
// =====================================================

if (require.main === module) {
  (async () => {
    try {
      const results =
        await searchProperties({
          city: 'المدينة المنورة',
          property_type: 'شقة',
          purpose: 'sale',
          limit: 5,
        });

      console.log(
        JSON.stringify(
          results,
          null,
          2
        )
      );

    } catch (error) {
      console.error(error);

    } finally {
      await pool.end();
    }
  })();
}


// =====================================================
// التصدير
// =====================================================

module.exports = {
  searchProperties,
  getPropertyByBayutId,
};
