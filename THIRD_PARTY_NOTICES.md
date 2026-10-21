# المكونات الخارجية

كود سَهم: Copyright (C) 2026 SAHM contributors، بموجب GPL-3.0-or-later. النص الكامل في LICENSE. لا تنقل هذه الرخصة ملكية أو تراخيص أي مكون خارجي إلى سَهم.

| المكوّن | المصدر والنسخة | موضع الرخصة |
|---|---|---|
| Electron وChromium وNode.js | إصدار Electron المثبت في package-lock.json | LICENSE وLICENSES.chromium.html في حزمة Windows، ورخص Electron والمكونات التابعة. |
| حزم JavaScript | dependencies في package.json والتفاصيل المقفلة في package-lock.json | ملفات LICENSE/NOTICE الخاصة بكل حزمة تحت node_modules في التطبيق. |
| yt-dlp | الإصدار 2026.08.19 من https://github.com/yt-dlp/yt-dlp | resources/media-runtime/licenses/yt-dlp-LICENSE.txt وyt-dlp-THIRD-PARTY-LICENSES.txt؛ الملف التنفيذي يضم مكونات إضافية ذات تراخيصها. |
| FFmpeg وFFprobe ومكتباتهما | N-127617-g94cba3150c، البناء المؤرخ autobuild-2026-10-17-20-33 من https://github.com/yt-dlp/FFmpeg-Builds | resources/media-runtime/licenses/ffmpeg/LICENSE.txt؛ إعداد البناء يتضمن enable-gpl وenable-version3. |
| Deno | v2.9.7 من https://github.com/denoland/deno | resources/media-runtime/licenses/deno-LICENSE.txt؛ MIT والمكونات التابعة. |

يحوي media-runtime.lock.json روابط الإصدارات وبصمات الأرشيفات والملفات التنفيذية والرخص. يُبقي البناء رخص Electron والمكتبات وأدوات الفيديو ضمن الحزمة.

قبل التوزيع العام للملفات التنفيذية، يجب إتاحة المصدر المطابق لـFFmpeg ومكتبات البناء التابعة ووصفات البناء مع الإصدار، ومراجعة إشعارات المكونات المرفقة داخل ملفات yt-dlp وDeno. رابط المستودع العام وحده لا يثبت اكتمال المصدر المطابق للبناء الموزع. هذه الخطوة ما زالت مفتوحة؛ حزمة مصدر سَهم لا تحتوي تلقائيًا مصادر جميع الأدوات الخارجية.

مراجع الناشرين: [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html)، و[تراخيص FFmpeg والتوزيع](https://ffmpeg.org/legal.html)، و[وصفات FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds).

لا تتضمن حزمة المصدر المصدرة ولا حزمة Windows ملفات IDM أو رخصته أو شفرته. سَهم مشروع مستقل، ولا ينتسب إلى Tonec أو IDM.
