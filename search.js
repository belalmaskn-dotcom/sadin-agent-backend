// search.js — الدالة اللي الـ agent هيستخدمها عشان يتأكد لو الطلب متوفر
const { db } = require('./db');

/**
 * @param {Object} criteria
 * @param {string} [criteria.city] - مثلاً "المدينة المنورة"
 * @param {string} [criteria.district] - مثلاً "العريض"
 * @param {string} [criteria.property_type] - مثلاً "شقة"
 * @param {string} [criteria.purpose] - "sale" | "rent"
 * @param {number} [criteria.min_area]
 * @param {number} [criteria.max_area]
 * @param {number} [criteria.min_rooms]
 * @param {number} [criteria.limit]
 * @returns {Array} قائمة العقارات المطابقة
 */
function searchProperties(criteria = {}) {
  const clauses = [];
  const params = {};

  if (criteria.city) {
    clauses.push('city LIKE @city');
    params.city = `%${criteria.city}%`;
  }
  if (criteria.district) {
    clauses.push('district LIKE @district');
    params.district = `%${criteria.district}%`;
  }
  if (criteria.property_type) {
    clauses.push('property_type LIKE @property_type');
    params.property_type = `%${criteria.property_type}%`;
  }
  if (criteria.purpose) {
    clauses.push('purpose = @purpose');
    params.purpose = criteria.purpose;
  }
  if (criteria.min_area) {
    clauses.push('area_sqm >= @min_area');
    params.min_area = criteria.min_area;
  }
  if (criteria.max_area) {
    clauses.push('area_sqm <= @max_area');
    params.max_area = criteria.max_area;
  }
  if (criteria.min_rooms) {
    clauses.push('rooms >= @min_rooms');
    params.min_rooms = criteria.min_rooms;
  }
  // العقارات المباعة لا تُعرض كمتاحة
  clauses.push("(license_status IS NULL OR license_status != 'تم البيع')");

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = criteria.limit || 5;

  const rows = db.prepare(`
    SELECT code, title, purpose, property_type, city, district, area_sqm, rooms, bathrooms, price, url
    FROM properties
    ${where}
    ORDER BY updated_at DESC
    LIMIT @limit
  `).all({ ...params, limit });

  return rows;
}

// مثال استخدام مباشر: node search.js
if (require.main === module) {
  const results = searchProperties({ city: 'المدينة', property_type: 'شقة', purpose: 'sale' });
  console.log(JSON.stringify(results, null, 2));
}

module.exports = { searchProperties };
