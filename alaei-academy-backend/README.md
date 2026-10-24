# آکادمی ریاضی استاد اعلایی‌نسب: بک‌اند

1. `cp .env.example .env` و مقادیر را پر کن (DB، JWT_SECRET، APP_SECRET).
2. `npm install`
3. `npm run db:init` (جدول‌ها + داده‌ی اولیه)
4. `npm run create-admin -- m0 manager "رمز-خیلی-قوی"` (ورود مدیر)
5. `npm start` و پوشه‌ی `frontend` را به `FRONTEND_DIR` بده (یا روی nginx/Apache سرو کن).

- پنل مدیریت: `/#/admin` → تب «هوش مصنوعی و امنیت» → دستیار را ویرایش کن (اسم، آواتار، رنگ، مدل، API، پرامپت). کلید API رمزنگاری شده در دیتابیس ذخیره می‌شود.
- AI: پیش‌فرض AvalAI (سرور داخل ایران). هر سرویس سازگار با OpenAI را می‌شود وصل کرد.
- SEO: `SITE_URL` را حتماً درست بزن؛ sitemap و robots در پوشه‌ی frontend هستند.
