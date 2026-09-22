// db.js — تخزين فهرس العقارات محليًا (SQLite)
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'properties.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    code TEXT PRIMARY KEY,
    title TEXT,
    purpose TEXT,          -- sale | rent | requested | auction
    property_type TEXT,    -- شقة / فيلا / أرض ...
    city TEXT,
    district TEXT,
    area_sqm REAL,
    rooms INTEGER,
    bathrooms INTEGER,
    price TEXT,            -- بيتحدث لاحقًا من صفحة التفاصيل (اختياري)
    license_status TEXT,
    url TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_city ON properties(city);
  CREATE INDEX IF NOT EXISTS idx_district ON properties(district);
  CREATE INDEX IF NOT EXISTS idx_type ON properties(property_type);
  CREATE INDEX IF NOT EXISTS idx_purpose ON properties(purpose);
`);

function upsertProperty(p) {
  const stmt = db.prepare(`
    INSERT INTO properties (code, title, purpose, property_type, city, district, area_sqm, rooms, bathrooms, price, license_status, url, updated_at)
    VALUES (@code, @title, @purpose, @property_type, @city, @district, @area_sqm, @rooms, @bathrooms, @price, @license_status, @url, datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      title=excluded.title, purpose=excluded.purpose, property_type=excluded.property_type,
      city=excluded.city, district=excluded.district, area_sqm=excluded.area_sqm,
      rooms=excluded.rooms, bathrooms=excluded.bathrooms, price=excluded.price,
      license_status=excluded.license_status, url=excluded.url, updated_at=datetime('now')
  `);
  stmt.run(p);
}

function countProperties() {
  return db.prepare('SELECT COUNT(*) as n FROM properties').get().n;
}

module.exports = { db, upsertProperty, countProperties };
