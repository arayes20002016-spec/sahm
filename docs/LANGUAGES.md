# العربية والإنجليزية

اختر «لغة الواجهة» من الإعدادات، ثم احفظ. تُحفظ اللغة عند إعادة التشغيل. تستخدم العربية اتجاه اليمين إلى اليسار، وتستخدم الإنجليزية اتجاه اليسار إلى اليمين؛ يسري الاختيار على العناوين والحقول وأسماء الملفات والروابط، حتى عندما تختلف لغة النص عن لغة الواجهة. تعرض الأرقام والتواريخ أرقامًا لاتينية 0–9، والتقويم ميلادي.

تغيير اللغة يعيد تحميل الواجهة فقط. تبقى التنزيلات جارية، وتُنقل مسودات الحقول عبر ذاكرة العملية ثم تُستهلك مرة واحدة. تنتهي صلاحية المسودة بعد 30 ثانية، ولا تُكتب كلمات المرور غير المحفوظة إلى ملف لاستعادة الواجهة. لا تُترجم أسماء الملفات أو القوائم التي سمّاها المستخدم.

تحتوي إضافة المتصفح على اختيار لغة مستقل. تتبع النافذة وزر الفيديو هذه اللغة، وتبقى لغة صفحة الموقع واتجاهها كما يحددهما الموقع. اختر اللغة في مثبت سَهم أيضًا؛ إعداد تكامل المتصفح يظل اختياريًا.

حقول الموعد تعرض `YYYY-MM-DDTHH:mm`، وحقول الوقت تعرض `HH:mm`. يقبل زر الساعة اختيار أجزاء الموعد داخل سَهم. يتيح ذلك احترام اتجاه الواجهة بدل الاتجاه الإجباري في حقول التاريخ الأصلية في Chromium.

# Arabic and English

Choose **Interface language** in Settings and save. Arabic uses RTL; English uses LTR. The selected direction applies to labels and control values, including URLs, paths and mixed-language text. Both languages use Latin digits 0–9 and Gregorian dates.

Changing language reloads the interface while downloads continue. Unsaved form drafts pass through process memory, are consumed once, and expire after 30 seconds. Password drafts are never written to disk for interface restoration. User filenames and custom queue names retain their original spelling.

The browser extension has its own language selector. Its popup and video controls follow that setting without changing the host webpage. The installer also offers Arabic and English. Browser integration remains an explicit optional choice.

Date/time fields use `YYYY-MM-DDTHH:mm`; time fields use `HH:mm`. The clock button opens SAHM’s date/time picker, whose fields follow the selected direction.

## Translation maintenance

Edit `locales/messages.json`, then run `npm run i18n:build`. Authored interface strings use `t`; backend errors are translated at the display boundary. Keep substitution tokens unchanged and pass user values separately. `node scripts/i18n-build.mjs --check` detects stale generated catalogues. Use the locale, draft-isolation, desktop and browser checks before releasing a translation change.
