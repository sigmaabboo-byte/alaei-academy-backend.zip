-- =====================================================================
--  آکادمی ریاضی استاد اعلایی‌نسب · Database schema
--  MySQL 8+ / MariaDB 10.6+   ·   utf8mb4 (full Persian + emoji support)
--  Import:  mysql -u root -p < database/schema.sql
-- =====================================================================
CREATE DATABASE IF NOT EXISTS alaei_academy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE alaei_academy;
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------- site settings (key/value JSON) ----------
CREATE TABLE IF NOT EXISTS settings (
  `key`        VARCHAR(64)  NOT NULL PRIMARY KEY,
  `value`      JSON         NOT NULL,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------- admins / managers / support ----------
CREATE TABLE IF NOT EXISTS admins (
  id            VARCHAR(32)  NOT NULL PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  username      VARCHAR(64)  NULL UNIQUE,
  password_hash VARCHAR(100) NULL,
  role          ENUM('manager','admin','support') NOT NULL DEFAULT 'admin',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at DATETIME     NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------- students ----------
CREATE TABLE IF NOT EXISTS students (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  phone       VARCHAR(20)  NOT NULL,
  grade       TINYINT      NOT NULL DEFAULT 7,
  bio         VARCHAR(500) NOT NULL DEFAULT '',
  ip          VARCHAR(45)  NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_phone (phone),
  INDEX idx_grade (grade)
) ENGINE=InnoDB;

-- ---------- packages & videos ----------
CREATE TABLE IF NOT EXISTS packages (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  grade       TINYINT      NOT NULL,
  title       VARCHAR(200) NOT NULL,
  description TEXT         NOT NULL,
  price       INT UNSIGNED NOT NULL DEFAULT 0,          -- Toman
  pay_link    VARCHAR(500) NULL,
  hue         SMALLINT     NOT NULL DEFAULT 180,
  sort_order  INT          NOT NULL DEFAULT 0,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_grade (grade)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS videos (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  package_id  VARCHAR(32)  NOT NULL,
  title       VARCHAR(200) NOT NULL,
  duration    SMALLINT     NOT NULL DEFAULT 0,           -- minutes
  src         VARCHAR(1000) NULL,                        -- URL of the video file / stream
  sort_order  INT          NOT NULL DEFAULT 0,
  FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
  INDEX idx_pkg (package_id, sort_order)
) ENGINE=InnoDB;

-- which student owns which package
CREATE TABLE IF NOT EXISTS enrollments (
  student_id  VARCHAR(32) NOT NULL,
  package_id  VARCHAR(32) NOT NULL,
  granted_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, package_id),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- discount codes & orders ----------
CREATE TABLE IF NOT EXISTS discount_codes (
  code        VARCHAR(40)  NOT NULL PRIMARY KEY,
  percent     TINYINT UNSIGNED NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  uses        INT UNSIGNED NOT NULL DEFAULT 0,
  max_uses    INT UNSIGNED NOT NULL DEFAULT 100,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  student_id  VARCHAR(32)  NOT NULL,
  package_id  VARCHAR(32)  NOT NULL,
  price       INT UNSIGNED NOT NULL,                     -- final price (Toman), computed on server
  code        VARCHAR(40)  NULL,
  status      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by VARCHAR(32)  NULL,
  reviewed_at DATETIME     NULL,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
  INDEX idx_status (status, created_at)
) ENGINE=InnoDB;

-- ---------- support tickets ----------
CREATE TABLE IF NOT EXISTS tickets (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  student_id  VARCHAR(32)  NOT NULL,
  subject     VARCHAR(200) NOT NULL,
  status      ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  INDEX idx_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ticket_messages (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id   VARCHAR(32)  NOT NULL,
  sender      ENUM('student','admin') NOT NULL,
  body        TEXT         NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  INDEX idx_ticket (ticket_id, created_at)
) ENGINE=InnoDB;

-- ---------- ask the teacher ----------
CREATE TABLE IF NOT EXISTS questions (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  student_id  VARCHAR(32)  NOT NULL,
  body        TEXT         NOT NULL,
  answer      TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at DATETIME     NULL,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------- FAQ ----------
CREATE TABLE IF NOT EXISTS faqs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  question    VARCHAR(400) NOT NULL,
  answer      TEXT         NOT NULL,
  sort_order  INT          NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- ---------- IP firewall ----------
CREATE TABLE IF NOT EXISTS ip_firewall (
  ip          VARCHAR(45)  NOT NULL PRIMARY KEY,
  who         VARCHAR(120) NOT NULL DEFAULT 'ناشناس',
  city        VARCHAR(80)  NOT NULL DEFAULT 'نامشخص',
  hits        INT UNSIGNED NOT NULL DEFAULT 0,
  blocked     TINYINT(1)   NOT NULL DEFAULT 0,
  last_seen   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_blocked (blocked)
) ENGINE=InnoDB;

-- ---------- AI assistant ----------
CREATE TABLE IF NOT EXISTS ai_settings (
  id          TINYINT      NOT NULL PRIMARY KEY DEFAULT 1,
  config      JSON         NOT NULL,                     -- name, avatar, colors, provider, model, prompt...
  api_key_enc TEXT         NULL,                         -- AES-256-GCM encrypted, never sent to browsers
  updated_by  VARCHAR(32)  NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (id = 1)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_conversations (
  id          VARCHAR(64)  NOT NULL PRIMARY KEY,         -- browser session id
  ip          VARCHAR(45)  NULL,
  page        VARCHAR(200) NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_messages (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(64) NOT NULL,
  role            ENUM('user','assistant') NOT NULL,
  content         TEXT        NOT NULL,
  tokens          INT         NULL,
  created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
  INDEX idx_conv (conversation_id, created_at),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- ---------- audit log ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id    VARCHAR(32)  NULL,
  action      VARCHAR(80)  NOT NULL,
  detail      JSON         NULL,
  ip          VARCHAR(45)  NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;

-- =====================================================================
--  Seed data (same content the site ships with)
-- =====================================================================
INSERT IGNORE INTO settings (`key`, `value`) VALUES
('site', JSON_OBJECT(
  'heroTitle','ریاضی را بفهم،', 'heroAccent','نه حفظ.',
  'lead','آکادمی ریاضی استاد اعلایی‌نسب، پکیج‌های ویدیویی ریاضی پایه‌های هفتم، هشتم و نهم را با آموزش مفهومی، تمرین هدفمند و پشتیبانی واقعی ارائه می‌کند تا دانش‌آموز با اعتمادبه‌نفس سر جلسه امتحان برود.',
  'slogans', JSON_ARRAY('هر فرمول، یک داستان دارد.','از ترس ریاضی تا عشق به ریاضی.','نمره‌ی بیست، نتیجه‌ی فهمیدن است.','یک قدم کوچک هر روز، یک جهش بزرگ در امتحان.'),
  'about','بیش از دو دهه تدریس ریاضی دوره‌ی متوسطه‌ی اول؛ با روشی که مفاهیم را از دل مثال‌های روزمره بیرون می‌کشد. هدف من این است که هیچ دانش‌آموزی از کلاس بیرون نرود مگر اینکه «چرا»ی هر فرمول را بداند.',
  'introVideo', NULL, 'maintenance', false, 'aiEnabled', true, 'blockScreenshots', true));

-- password of the manager is set by:  npm run create-admin
INSERT IGNORE INTO admins (id, name, role) VALUES
('m0','استاد اعلایی‌نسب','manager'),('a1','ادمین فروش ۱','admin'),('a2','ادمین فروش ۲','admin'),
('a3','ادمین محتوا','admin'),('a4','ادمین کاربران','admin'),('a5','پشتیبانی','support');

INSERT IGNORE INTO packages (id, grade, title, description, price, pay_link, hue, sort_order) VALUES
('p7a',7,'ریاضی هفتم، از صفر تا بیست','همه‌ی فصل‌های کتاب هفتم با مثال‌های تصویری، تمرین‌های طبقه‌بندی‌شده و جمع‌بندی شب امتحان.',890000,'https://zarinp.al/example-7a',172,1),
('p7b',7,'جمع‌بندی شب امتحان هفتم','مرور سریع و نکته‌محور همه‌ی فصل‌ها برای روزهای آخر قبل از امتحان نوبت اول و دوم.',390000,'https://zarinp.al/example-7b',196,2),
('p8a',8,'ریاضی هشتم، مفهومی و عمیق','عددهای گویا تا دایره؛ هر جلسه با یک سؤال جذاب شروع و با تسلط کامل تمام می‌شود.',950000,'https://zarinp.al/example-8a',210,3),
('p8b',8,'هندسه‌ی هشتم با تصویر','مثلث، چندضلعی و دایره با انیمیشن‌های هندسی که اثبات‌ها را قابل‌دیدن می‌کنند.',520000,'https://zarinp.al/example-8b',160,4),
('p9a',9,'ریاضی نهم، آمادگی امتحان نهایی','مجموعه‌ها تا معادله‌ی درجه دوم؛ کامل‌ترین مسیر برای نهایی و آزمون ورودی تیزهوشان.',1250000,'https://zarinp.al/example-9a',186,5),
('p9b',9,'تیزهوشان نهم: تست و تکنیک','تکنیک‌های تستی، مدیریت زمان و حل سؤال‌های سال‌های گذشته‌ی آزمون تیزهوشان.',1100000,'https://zarinp.al/example-9b',228,6);

INSERT IGNORE INTO videos (id, package_id, title, duration, sort_order) VALUES
('v7a1','p7a','راهبردهای حل مسئله',24,1),('v7a2','p7a','عددهای صحیح',31,2),('v7a3','p7a','جبر و معادله',18,3),('v7a4','p7a','هندسه و استدلال',42,4),
('v7a5','p7a','شمارنده‌ها و عددهای اول',27,5),('v7a6','p7a','سطح و حجم',24,6),('v7a7','p7a','توان و جذر',31,7),('v7a8','p7a','بردار و مختصات',18,8),('v7a9','p7a','آمار و احتمال',42,9),
('v7b1','p7b','نقشه‌ی راه امتحان',15,1),('v7b2','p7b','نکات طلایی فصل ۱ تا ۳',22,2),('v7b3','p7b','نکات طلایی فصل ۴ تا ۶',19,3),('v7b4','p7b','نمونه‌سوال نهایی',15,4),
('v8a1','p8a','عددهای صحیح و گویا',28,1),('v8a2','p8a','عددهای اول',35,2),('v8a3','p8a','چندضلعی‌ها',21,3),('v8a4','p8a','جبر و معادله',40,4),('v8a5','p8a','بردار و مختصات',28,5),
('v8a6','p8a','مثلث',35,6),('v8a7','p8a','توان و جذر',21,7),('v8a8','p8a','آمار و احتمال',40,8),('v8a9','p8a','دایره',28,9),
('v8b1','p8b','زاویه‌ها و توازی',26,1),('v8b2','p8b','همنهشتی مثلث‌ها',33,2),('v8b3','p8b','قضیه‌ی فیثاغورس',26,3),('v8b4','p8b','زاویه‌های محاطی',33,4),
('v9a1','p9a','مجموعه‌ها',32,1),('v9a2','p9a','عددهای حقیقی',38,2),('v9a3','p9a','استدلال و اثبات',29,3),('v9a4','p9a','توان و ریشه',45,4),
('v9a5','p9a','عبارت‌های جبری',32,5),('v9a6','p9a','خط و معادله‌های خطی',38,6),('v9a7','p9a','عبارت‌های گویا',29,7),('v9a8','p9a','حجم و مساحت',45,8),
('v9b1','p9b','استراتژی آزمون',36,1),('v9b2','p9b','تست‌های جبر',41,2),('v9b3','p9b','تست‌های هندسه',30,3),('v9b4','p9b','تست‌های هوش ریاضی',36,4),('v9b5','p9b','آزمون شبیه‌ساز',41,5);

INSERT IGNORE INTO students (id, name, phone, grade, bio, ip) VALUES
('u1','آرین محمدی','0912•••4521',9,'عاشق هندسه‌ام.','5.112.44.18'),
('u2','نیلوفر احمدی','0935•••8810',8,'','37.98.120.6'),
('u3','محمدرضا کریمی','0919•••3307',7,'','91.251.3.77');
INSERT IGNORE INTO enrollments (student_id, package_id) VALUES ('u1','p9a'),('u3','p7a');

INSERT IGNORE INTO discount_codes (code, percent, active, uses, max_uses) VALUES ('OFF10',10,1,1,100),('NOROOZ30',30,0,0,50);

INSERT IGNORE INTO orders (id, student_id, package_id, price, code, status, created_at) VALUES
('o1','u2','p8a',855000,'OFF10','pending',  NOW() - INTERVAL 18 MINUTE),
('o2','u1','p9a',1250000,NULL,  'approved', NOW() - INTERVAL 30 HOUR),
('o3','u3','p7a',890000,NULL,   'approved', NOW() - INTERVAL 70 HOUR);

INSERT IGNORE INTO tickets (id, student_id, subject, status) VALUES ('t1','u1','ویدیوی فصل ۳ کند لود می‌شود','open');
INSERT INTO ticket_messages (ticket_id, sender, body, created_at)
  SELECT 't1','student','سلام، ویدیوی استدلال و اثبات روی موبایل کند باز می‌شه.', NOW() - INTERVAL 1 HOUR
  WHERE NOT EXISTS (SELECT 1 FROM ticket_messages WHERE ticket_id = 't1');

INSERT IGNORE INTO questions (id, student_id, body, answer, created_at, answered_at) VALUES
('q1','u3','استاد، چرا تقسیم بر صفر تعریف نشده؟','چون هیچ عددی وجود ندارد که ضربش در صفر، عدد غیرصفر بدهد. اگر ۵ ÷ ۰ = x باشد، باید x × ۰ = ۵ شود که ممکن نیست.', NOW() - INTERVAL 1 DAY, NOW()),
('q2','u1','برای تیزهوشان از کدام فصل شروع کنم؟',NULL, NOW() - INTERVAL 2 HOUR, NULL);

INSERT INTO faqs (question, answer, sort_order)
SELECT * FROM (SELECT 'بعد از خرید، چقدر طول می‌کشد پکیج فعال شود؟' q,'تأیید خرید دستی است؛ معمولاً کمتر از یک ساعت بعد از پرداخت، ادمین پکیج را در پنل شما فعال می‌کند.' a,1 s UNION ALL
 SELECT 'ویدیوها را می‌توانم دانلود کنم؟','خیر. ویدیوها فقط به‌صورت آنلاین و داخل پنل دانش‌آموزی پخش می‌شوند تا محتوا محافظت شود.',2 UNION ALL
 SELECT 'دسترسی به پکیج تا کی است؟','دسترسی تا پایان سال تحصیلی همان پایه فعال است و ویدیوهای جدید هم بدون هزینه اضافه می‌شوند.',3 UNION ALL
 SELECT 'اگر سؤالی داشتم از چه کسی بپرسم؟','سؤال‌های درسی را در بخش «پرسش از استاد» مستقیم از خود استاد بپرسید؛ مشکلات فنی را به پشتیبانی بگویید.',4 UNION ALL
 SELECT 'پرداخت امن است؟','بله. پرداخت از طریق درگاه رسمی بانکی داخلی انجام می‌شود و هیچ اطلاعات کارتی روی سایت ما ذخیره نمی‌شود.',5) t
WHERE NOT EXISTS (SELECT 1 FROM faqs);

INSERT IGNORE INTO ip_firewall (ip, who, city, hits, blocked) VALUES
('5.112.44.18','آرین محمدی','تهران',142,0),('37.98.120.6','نیلوفر احمدی','مشهد',58,0),
('185.220.101.4','ناشناس','نامشخص',911,1),('91.251.3.77','محمدرضا کریمی','اصفهان',77,0);

INSERT IGNORE INTO ai_settings (id, config) VALUES (1, JSON_OBJECT(
  'enabled', true, 'name','دستیار ریاضی آکادمی', 'subtitle','آنلاین · پاسخ در چند ثانیه', 'avatar','🤖', 'avatarUrl','',
  'greeting','سلام! 👋 من دستیار هوشمند آکادمی استاد اعلایی‌نسب هستم. درباره‌ی پکیج‌ها، خرید، یا هر سؤال ریاضی پایه‌ی هفتم تا نهم ازم بپرس.',
  'hint','سؤال ریاضی داری؟ 😊', 'color','#00C2A8', 'position','left',
  'suggestions', JSON_ARRAY('کدوم پکیج برای پایه‌ی نهم خوبه؟','خرید چطور فعال می‌شه؟','معادله‌ی درجه دوم رو توضیح بده'),
  'provider','avalai', 'baseUrl','https://api.avalai.ir/v1', 'model','gpt-4o-mini', 'temperature',0.5, 'maxTokens',700, 'stream', true,
  'systemPrompt','تو دستیار هوشمند «آکادمی ریاضی استاد اعلایی‌نسب» هستی. همیشه فارسی، مودب، کوتاه و دوستانه جواب بده. به دانش‌آموزان پایه‌ی هفتم، هشتم و نهم ریاضی را مفهومی و قدم‌به‌قدم توضیح بده (جواب نهایی تکلیف را مستقیم نده، راه را یاد بده). درباره‌ی پکیج‌ها فقط از اطلاعات سایت استفاده کن و قیمت را دقیق بگو. اگر چیزی را نمی‌دانی، دانش‌آموز را به بخش پشتیبانی یا «پرسش از استاد» راهنمایی کن.',
  'useSiteKnowledge', true, 'mode','server', 'footer','پاسخ‌ها با هوش مصنوعی تولید می‌شوند', 'maxHistory',12, 'rateLimitPerMin',10));
