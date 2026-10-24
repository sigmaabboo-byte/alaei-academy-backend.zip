# آکادمی ریاضی استاد اعلایی‌نسب: بک‌اند (Express + PostgreSQL)

بک‌اند و API سایت آکادمی. دیتابیس **PostgreSQL** است و برای استقرار روی **Render** آماده شده است.
اتصال دیتابیس فقط از متغیر محیطی `DATABASE_URL` خوانده می‌شود؛ هیچ رمز، کلید یا آدرس واقعی‌ای در کد نیست.

## ساختار پروژه

| مسیر | کار |
|---|---|
| `src/server.js` | سرور Express، ورود مدیر، فایروال IP، سرو فرانت‌اند، خاموشی تمیز (SIGTERM) |
| `src/db.js` | اتصال PostgreSQL (`pg`): Pool، تنظیم SSL، `q()` و `tx()` (تراکنش) |
| `src/lib.js` | JWT، رمزنگاری کلید AI، توابع کمکی |
| `src/routes/state.js` | API داده‌ها (`/api/state`، `/api/admin/state`، `/api/public/events`) |
| `src/routes/assistant.js` | دستیار هوشمند (چت عمومی + تنظیمات مدیر) |
| `database/schema.sql` | اسکیمای PostgreSQL + داده‌ی اولیه (idempotent) |
| `scripts/init-db.js` | ساخت جدول‌ها و داده‌ی اولیه (`npm run db:init`) |
| `scripts/create-admin.js` | تنظیم نام‌کاربری/رمز مدیر (`npm run create-admin`) |
| `tests/` | تست‌ها (ایستا بدون دیتابیس + تست یکپارچه روی PostgreSQL واقعی) |
| `render.yaml` | Blueprint برای ساخت سرویس وب و دیتابیس روی Render |

## متغیرهای محیطی

| متغیر | توضیح |
|---|---|
| `DATABASE_URL` | **الزامی.** `postgresql://USER:PASSWORD@HOST:5432/DBNAME` (کاراکترهای خاص رمز را URL-encode کنید) |
| `DATABASE_SSL` | `auto` (پیش‌فرض) / `require` / `verify` / `disable`. در حالت `auto`: برای `localhost` و هاست داخلی Render (بدون نقطه در نام) بدون SSL، برای بقیه با SSL |
| `DATABASE_CA_CERT` | فقط برای `verify`: متن PEM گواهی CA (اختیاری) |
| `DB_POOL_MAX` | حداکثر اتصال همزمان (پیش‌فرض ۱۰) |
| `JWT_SECRET`, `APP_SECRET` | **الزامی در production.** رشته‌ی تصادفیِ بلند. بدون آن‌ها سرور در حالت production بالا نمی‌آید |
| `SITE_URL`, `FRONTEND_DIR`, `CORS_ORIGINS`, `TRUST_PROXY`, `PORT` | مثل قبل (نمونه در `.env.example`) |
| `AI_API_KEY` | اختیاری؛ روی کلید ذخیره‌شده در پنل مدیریت اولویت دارد |

تولید رشته‌ی تصادفی:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## اجرای محلی

```bash
# یک PostgreSQL محلی (نمونه با Docker؛ به‌جای PASSWORD رمز دلخواه خودتان را بگذارید)
docker run -d --name alaei-pg -e POSTGRES_PASSWORD=PASSWORD -e POSTGRES_DB=alaei_academy -p 5432:5432 postgres:16

cp .env.example .env
# در .env این‌ها را پر کنید:
#   DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/alaei_academy
#   JWT_SECRET=...   APP_SECRET=...

npm install
npm run db:init                                              # جدول‌ها + داده‌ی اولیه
npm run create-admin -- m0 manager "رمز-خیلی-قوی-و-بلند"     # رمز مدیر (حداقل ۱۰ کاراکتر)
npm start
```

## استقرار روی Render

### روش ۱: با Blueprint (پیشنهادی)

1. پروژه را در یک مخزن Git (GitHub/GitLab/Bitbucket) قرار دهید؛ فایل `render.yaml` باید در ریشه‌ی مخزن باشد.
2. در داشبورد Render: **New → Blueprint** و مخزن را انتخاب کنید. Render یک دیتابیس PostgreSQL و یک سرویس وب می‌سازد؛
   `DATABASE_URL` از دیتابیس تزریق می‌شود و `JWT_SECRET` و `APP_SECRET` به‌صورت خودکار تولید می‌شوند.
3. مقدار `SITE_URL` (و در صورت نیاز `CORS_ORIGINS`، `AI_API_KEY`) را در داشبورد پر کنید.
4. جدول‌ها را بسازید و مدیر را تعریف کنید (بخش «راه‌اندازی اولیه‌ی دیتابیس» پایین).

### روش ۲: دستی

1. **New → PostgreSQL** بسازید (نام دیتابیس مثلاً `alaei_academy`). **Region** را یادداشت کنید.
2. **New → Web Service** و مخزن را انتخاب کنید، **در همان Region دیتابیس**:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/api/health`
3. در **Environment**:
   - `DATABASE_URL` = **Internal Database URL** دیتابیس (از منوی Connect صفحه‌ی دیتابیس)
   - `NODE_ENV=production`، `JWT_SECRET`، `APP_SECRET` (رشته‌های تصادفیِ بلند)، `TRUST_PROXY=1`، `SITE_URL`
4. Deploy کنید و سپس دیتابیس را راه‌اندازی کنید.

### راه‌اندازی اولیه‌ی دیتابیس (یک بار)

از **External Database URL** دیتابیس استفاده کنید (Render روی اتصال خارجی SSL را الزامی می‌کند؛ برنامه به‌صورت خودکار SSL را روشن می‌کند).
دستورها را از کامپیوتر خودتان اجرا کنید (روی همه‌ی پلن‌ها کار می‌کند و به Shell سرویس نیازی ندارد):

```bash
export DATABASE_URL='<External Database URL>'     # در تاریخچه‌ی شل یا مخزن ذخیره نکنید
npm install
npm run db:init
ADMIN_PASSWORD='رمز-خیلی-قوی-و-بلند' npm run create-admin -- m0 manager
```

اگر پلن شما از **Pre-Deploy Command** پشتیبانی می‌کند می‌توانید `npm run db:init` را همان‌جا بگذارید
(اسکیما idempotent است و چندبار اجرا کردنش بی‌خطر است). ساخت رمز مدیر را همچنان یک بار دستی انجام دهید.

### بررسی سلامت

- `GET /api/health` → `{"ok":true}`
- `GET /api/health/db` → `{"ok":true,"db":"up"}` (اتصال دیتابیس را هم بررسی می‌کند)
- ورود به پنل: `/#/admin` با نام‌کاربری و رمزی که با `create-admin` تعیین کردید (نام‌کاربری به بزرگی/کوچکی حروف حساس نیست).

### فرانت‌اند

- هم‌دامنه: پوشه‌ی build فرانت‌اند را در مخزن بگذارید و `FRONTEND_DIR` را به آن اشاره دهید.
- جدا (مثلاً Static Site در Render): `FRONTEND_DIR` را تنظیم نکنید و دامنه‌ی فرانت را در `CORS_ORIGINS` بگذارید.
  در این حالت مسیرهای غیر `/api` پاسخ `404 JSON` می‌دهند.

## تست‌ها

```bash
npm run test:static     # بدون دیتابیس: نحو SQL، اسکیما، ایندکس‌ها، تحلیل DATABASE_URL/SSL، نبودن رمز در کد
TEST_DATABASE_URL='postgresql://...' npm run test:db   # روی PostgreSQL واقعی
```

`test:db` را فقط روی یک **دیتابیس آزمایشی** اجرا کنید (نه production). این تست: اتصال، ساخت اسکیما (دوبار)، کلید خارجی و cascade،
enumها، تریگر `updated_at`، تراکنش و rollback، ورود مدیر، رفت‌وبرگشت کامل state، رویدادهای عمومی (قیمت و کد تخفیف)،
فایروال IP و مسیرهای دستیار هوشمند را بررسی می‌کند و ردیف‌های ساخته‌شده‌ی خودش را پاک می‌کند.

## نکته‌های مهم

- **پلن رایگان Render Postgres دائمی نیست** (طبق مستندات Render بعد از ۳۰ روز منقضی می‌شود). برای سایت واقعی پلن پولی بگیرید و پشتیبان‌گیری را فعال کنید.
- **این پروژه داده‌های موجود MySQL را منتقل نمی‌کند.** `schema.sql` فقط اسکیما و داده‌ی اولیه‌ی همیشگی سایت را می‌سازد. برای انتقال دانش‌آموزان/سفارش‌های واقعی یک مهاجرت جداگانه لازم است (مثلاً با ابزار `pgloader`) و باید روی کپی داده تست شود.
- اگر اتصال خارجی با خطای SSL قطع شد: `DATABASE_SSL=require`. برای اعتبارسنجی کامل گواهی: `DATABASE_SSL=verify` (و در صورت نیاز `DATABASE_CA_CERT`).
- پنل مدیریت: `/#/admin` ← تب «هوش مصنوعی و امنیت» ← ویرایش دستیار (اسم، آواتار، رنگ، مدل، API، پرامپت). کلید API رمزنگاری‌شده در دیتابیس ذخیره می‌شود.
- AI: پیش‌فرض AvalAI؛ هر سرویس سازگار با OpenAI قابل اتصال است.
- SEO: `SITE_URL` را درست بگذارید؛ sitemap و robots در پوشه‌ی frontend هستند.
