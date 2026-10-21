import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractFile, listPackage } from '@electron/asar';
import sevenZipBinary from '7zip-bin';
import { verifyRuntime } from './lib/runtime-integrity.mjs';
import { prepareBuildStorage } from './lib/build-storage.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const canonicalSource = project;
const sourcePackage = JSON.parse(await readFile(path.join(canonicalSource, 'package.json'), 'utf8'));
const { version } = sourcePackage;
assert.match(version, /^\d+\.\d+\.\d+$/, 'Release version must be a stable semantic version');
const release = process.env.SAHM_RELEASE_DIRECTORY ? path.resolve(process.env.SAHM_RELEASE_DIRECTORY) : path.join(canonicalSource, 'dist', version);
const portable = process.env.SAHM_PORTABLE_DIRECTORY ? path.resolve(process.env.SAHM_PORTABLE_DIRECTORY) : path.join(release, 'SAHM-win32-x64');
const artifactVersion = version.endsWith('.0') ? version.split('.').slice(0, 2).join('.') : version;
const installer = path.join(release, `SAHM-Setup-${version}.exe`);
const archive = path.join(portable, 'resources', 'app.asar');
const sevenZip = sevenZipBinary.path7za;
const artifactDirectory = path.join(canonicalSource, 'artifacts');
const execute = promisify(execFile);
const digestCache = new Map();
const slash = value => value.replaceAll('\\', '/');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function sha256(file) {
  if (digestCache.has(file)) return digestCache.get(file);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = hash.digest('hex');
  digestCache.set(file, digest);
  return digest;
}

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(file));
    else if (entry.isFile()) output.push(file);
    else throw new Error('Unexpected symbolic or special file: ' + file);
  }
  return output.sort();
}

async function runSevenZip(args) {
  return execute(sevenZip, args, { cwd: project, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
}

await mkdir(artifactDirectory, { recursive: true });
console.log('VERIFY: validating the embedded 7z CRC without executing the installer');
const integrity = await runSevenZip(['t', '-t7z', installer]);
assert.match(integrity.stdout, /Everything is Ok/);
await writeFile(path.join(artifactDirectory, `sahm-${artifactVersion}-installer-crc.log`), integrity.stdout + integrity.stderr);
const listing = await runSevenZip(['l', '-slt', '-t7z', installer]);
const payloadEntries = listing.stdout.split(/\r?\n/).filter(line => line.startsWith('Path = ')).map(line => line.slice(7)).filter(value => !samePath(value, installer)).map(slash);
for (const entry of payloadEntries) assert.ok(!entry.startsWith('/') && !/^[a-z]:/i.test(entry) && !entry.split('/').includes('..'), 'Unsafe payload path: ' + entry);
const required = [
  'SAHM.exe', 'resources/app.asar', 'resources/browser/extension/manifest.json',
  'resources/browser/extension/background.mjs', 'resources/browser/extension/media-overlay.js',
  'resources/browser/extension/post-downloads.mjs', 'resources/browser/completed-file.mjs',
  'resources/browser/native-host.mjs', 'resources/media-runtime/manifest.json',
  'resources/media-runtime/yt-dlp.exe', 'resources/media-runtime/ffmpeg.exe',
  'resources/media-runtime/ffprobe.exe', 'resources/media-runtime/deno.exe',
  'resources/media-runtime/licenses/yt-dlp-LICENSE.txt',
  'resources/media-runtime/licenses/yt-dlp-THIRD-PARTY-LICENSES.txt',
  'resources/media-runtime/licenses/deno-LICENSE.txt',
  'resources/media-runtime/licenses/ffmpeg/LICENSE.txt',
];
for (const entry of required) assert.ok(payloadEntries.includes(entry), 'Missing installer payload file: ' + entry);

console.log('VERIFY: comparing packaged production sources with canonical D source');
const packagedManifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
assert.equal(packagedManifest.version, version);
assert.equal(packagedManifest.license, sourcePackage.license);
for (const relative of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'media-runtime.lock.json']) {
  assert.deepEqual(extractFile(archive, relative), await readFile(path.join(canonicalSource, relative)), 'Packaged license or dependency lock differs: ' + relative);
}
assert.equal(packagedManifest.main, sourcePackage.main);
assert.deepEqual(packagedManifest.dependencies, sourcePackage.dependencies);
const archivedEntries = listPackage(archive).map(slash);
assert.ok(!archivedEntries.some(entry => /^\/(?:artifacts|research|test|scripts|build|dist|downloads|docs|\.github|\.impeccable|\.git)(?:\/|$)/.test(entry)), 'Development or investigation artifacts leaked into the application archive');
assert.ok(!archivedEntries.some(entry => /\/(?:idman|idmbrbtn|idmmsghost)\.(?:exe|dll)$/i.test(entry)), 'An IDM binary leaked into the application');
assert.ok(!archivedEntries.includes('/SOURCE-MANIFEST.json'), 'Source export inventory leaked into the runtime archive');
assert.ok(!archivedEntries.some(entry => /^\/\.sahm-qa(?:\/|$)|\.(?:qcow2?|vhdx?|vdi)$/i.test(entry)), 'VM lab data leaked into the runtime archive');
const sourceFiles = [];
for (const directory of ['locales', 'src', 'ui', 'electron', 'assets', 'browser']) {
  for (const file of await files(path.join(canonicalSource, directory))) {
    const relative = path.relative(canonicalSource, file), current = await readFile(file);
    assert.deepEqual(extractFile(archive, relative), current, 'Packaged source differs: ' + slash(relative));
    if (directory === 'browser') assert.deepEqual(await readFile(path.join(portable, 'resources', relative)), current, 'External browser resource differs: ' + slash(relative));
    sourceFiles.push({ path: slash(relative), bytes: current.length, sha256: await sha256(file) });
  }
}
assert.equal(JSON.parse(await readFile(path.join(portable, 'resources', 'browser', 'extension', 'manifest.json'), 'utf8')).version, version);

// Only this newly created verify-* child is removed. The parent can be placed
// on a drive with free space; existing releases and profiles stay untouched.
if (process.env.SAHM_VERIFY_TEMPORARY_DIRECTORY) assert.ok(path.isAbsolute(process.env.SAHM_VERIFY_TEMPORARY_DIRECTORY), 'Verification temporary directory must be absolute');
const temporaryParent = process.env.SAHM_VERIFY_TEMPORARY_DIRECTORY || path.join(release, '.verify-temp');
await prepareBuildStorage({ output: release, temporaryDirectory: temporaryParent, outputBytes: 0 });
await mkdir(temporaryParent, { recursive: true });
const realParent = await realpath(temporaryParent);
assert.notEqual(path.parse(realParent).root.toLowerCase(), realParent.toLowerCase(), 'Verification parent cannot be the drive root');
const extracted = await mkdtemp(path.join(realParent, 'verify-'));
let report;
try {
  console.log('VERIFY: extracting a temporary verification copy into ' + extracted);
  const extraction = await runSevenZip(['x', '-t7z', '-y', '-o' + extracted, installer]);
  assert.match(extraction.stdout, /Everything is Ok/);
  const portableFiles = await files(portable), extractedFiles = await files(extracted);
  assert.deepEqual(extractedFiles.map(file => slash(path.relative(extracted, file))).sort(), portableFiles.map(file => slash(path.relative(portable, file))).sort(), 'Installer payload file inventory differs from the portable package');
  for (const file of portableFiles) {
    const relative = path.relative(portable, file);
    assert.equal(await sha256(path.join(extracted, relative)), await sha256(file), 'Installer payload differs from portable package: ' + relative);
  }
  assert.equal(JSON.parse(await readFile(path.join(extracted, 'resources', 'browser', 'extension', 'manifest.json'), 'utf8')).version, version);
  const runtime = JSON.parse(await readFile(path.join(extracted, 'resources', 'media-runtime', 'manifest.json'), 'utf8'));
  await verifyRuntime(path.join(extracted, 'resources', 'media-runtime'), JSON.parse(await readFile(path.join(canonicalSource, 'media-runtime.lock.json'), 'utf8')));
  const runtimeFiles = [];
  for (const dependency of runtime.dependencies) {
    for (const expected of dependency.installed) {
      assert.match(expected.name, /^[a-zA-Z0-9._-]+$/); assert.match(expected.sha256, /^[a-fA-F0-9]{64}$/);
      const file = path.join(extracted, 'resources', 'media-runtime', expected.name);
      assert.equal((await stat(file)).size, expected.size);
      assert.equal(await sha256(file), expected.sha256.toLowerCase(), 'Runtime publisher hash mismatch: ' + expected.name);
      runtimeFiles.push({ name: expected.name, bytes: expected.size, sha256: expected.sha256.toLowerCase() });
    }
  }

  const startHere = `سَهم ${version} لتجربة Windows

1. أغلق النسخة القديمة من أيقونتها بجوار الساعة واختر «خروج». إغلاق النافذة وحده يُبقيها تعمل في الخلفية.
2. شغّل SAHM-Setup-${version}.exe للتثبيت. ويمكن تشغيل النسخة المباشرة من ${path.join(portable, 'SAHM.exe')} مع الاحتفاظ بالمجلد كاملًا.
3. إذا أردت تكامل المتصفح، وافق على بدء إعداده في المثبّت ثم شغّل سَهم. من «المتصفح» اضغط «تسجيل الاتصال» ثم «فتح المجلد».
4. حدّث إضافة سَهم في Chrome أو Edge إلى ${version}. أزل النسخة المحمّلة من مسار قديم، ثم فعّل وضع المطوّر واختر «تحميل إضافة غير مضغوطة» وحدّد المجلد الذي فتحه سَهم. للنسخة المباشرة مساره:
${path.join(portable, 'resources', 'browser', 'extension')}
5. فعّل الالتقاط وزر الفيديو من نافذة الإضافة، واترك سَهم يعمل. أعد تحميل صفحة الفيديو بعد تحديث الإضافة. في YouTube اختر الجودة من الزر. قد يُخفي ملء الشاشة الأصلي لعنصر الفيديو وحده عناصر الصفحة الأخرى.
6. جرّب FTP بإضافة رابط ftp:// لملف أو ftps:// لاتصال TLS ضمني. اختر TLS الصريح عند الحاجة، وأدخل الحساب في الحقول المخصصة. حفظ كلمة المرور اختياري ومشفّر لحساب Windows الحالي؛ عند عدم حفظها ستحتاج إدخالها بعد إعادة تشغيل سَهم.
7. من إعدادات الاتصال اختر اتصالًا مباشرًا أو وكيل HTTP/HTTPS أو SOCKS4/5 أو إعدادات Windows أو PAC. فشل الوكيل لا يحوّل النقل إلى اتصال مباشر تلقائيًا؛ يحتاج PAC إلى DIRECT صريح لهذا المسار.
8. افتح «نسخ المواقع» وأدخل رابط البداية والحدود. اختر «HTML والملفات الثابتة» للصفحات العادية، أو «لقطة بعد تشغيل JavaScript» للمحتوى الذي تبنيه الصفحة بعد تحميلها. للموقع المحمي اضغط «تسجيل الدخول…»، وأكمل الدخول في نافذته، ثم اختر «استخدام الجلسة لهذا الموقع» من القائمة. اختر الجلسة وابدأ النسخ. تُحفظ الصفحات والصور والتنسيقات على القرص، وتُعطّل السكربتات والنماذج في اللقطة المحلية؛ لا تتحول خدمات API إلى تطبيق يعمل دون اتصال. الجلسة وبيانات تخزين المتصفح مؤقتة في الذاكرة. بعد الخروج من سَهم استخدم «تسجيل الدخول والمتابعة» لإكمال الملفات المتبقية؛ تبقى الملفات المكتملة محفوظة. «إنهاء الجلسة» يوقف النسخ الذي يستخدمها ويمسح بياناتها، ويُبقي الملفات.
9. افتح «المزامنة وحصة التنزيل» وأضف روابط الملفات العامة، كل رابط في سطر، وحدّد الفترة بالدقائق. يتحقق سَهم من الملفات أثناء عمله ويستخدم ETag أو Last-Modified لتجنب تنزيل النسخ التي لم تتغير. إذا تغيّر الملف يحفظ النسخة السابقة قبل نشر الجديدة؛ وإذا عدّلت الملف محليًا يوقف استبداله ويعرض تعارضًا.
10. من الصفحة نفسها فعّل الحصة وحدّد الحجم بالميجابايت ومدة الفترة بالساعات. يبدأ أول ضبط للمدة مباشرة إذا كان العداد خاليًا؛ بعد بدء الاستهلاك يسري تغيير المدة من الفترة التالية. العداد محفوظ بعد إعادة التشغيل، ورفع الحد لا يمسح الاستهلاك الحالي. عند نفاد الحصة تتوقف البيانات الجديدة وتُستأنف تنزيلات GET القابلة للاستئناف عند تجددها. مهام POST غير المكتملة من الإصدارات القديمة تبقى متوقفة؛ لا يعيد سَهم إرسالها.
11. من «القوائم والجدولة» اختر قائمة ثم حدّد «بعد اكتمال القائمة» واحفظها قبل تنزيل ملفات جديدة. يمكنك عرض إشعار أو فتح مجلد التنزيلات الافتراضي أو إغلاق سَهم أو اختيار إيقاف الجهاز أو السكون أو الإسبات. يُنفّذ الإجراء مرة واحدة بعد اكتمال ملفات القائمة وانتهاء الفحص والنقل؛ الملفات المكتملة سابقًا لا تُعيد تشغيله عند فتح سَهم. تحتاج إجراءات الطاقة وإغلاق التطبيق إلى مهلة لا تقل عن 30 ثانية، ويمكن إلغاؤها من الشريط الظاهر في التطبيق. إضافة عمل غير مكتمل أثناء العد تُلغي إجراء الطاقة. تعتمد إجراءات الطاقة على صلاحيات Windows ودعم الجهاز، ولا تُجبر التطبيقات الأخرى على الإغلاق.
12. من جدول التنزيلات اضغط «الأعمدة…» لإظهار الأعمدة أو إخفائها وترتيبها وضبط عرضها بالبكسل. يبقى اسم الملف وعمود التحديد ظاهرين. يمكن سحب فاصل رأس العمود لتغيير العرض، أو التركيز عليه واستخدام السهمين؛ يغيّر Shift مقدار التعديل. تحفظ الإعدادات ترتيب الأعمدة وعرضها والفرز لإعادة فتح سَهم. يعيد زر استعادة الإعدادات الأعمدة الافتراضية بعد حفظ الحوار.
13. من «الشبكة والوكيل» يمكنك اختيار الاكتشاف التلقائي WPAD، أو قراءة إعدادات Windows، أو تحديد PAC يدويًا. يستخدم الاكتشاف واجهات Windows ولا يغيّر إعدادات النظام. إذا لم تعثر الشبكة على PAC، حدّد عنوانه أو بيانات الوكيل يدويًا؛ لا يعني فشل الاكتشاف السماح باتصال مباشر تلقائيًا.
14. لمصادقة وكيل HTTP أو HTTPS اختر NTLM أو Negotiate. تسري مصادقة الوكيل أيضًا على قناتي التحكم والبيانات في FTP وFTPS. استخدام حساب Windows الحالي يحتاج إلى تفعيله وإدراج أسماء الوكلاء الموثوقين، كل اسم في سطر ودون بروتوكول أو منفذ أو *. للحساب الصريح استخدم الحقول المخصصة ويمكن كتابة DOMAIN\\user. وللمواقع أضف أصل الموقع، مثل https://intranet.example.com:8443، واختر طريقة المصادقة والحساب. تشمل مطابقة الأصل البروتوكول والاسم والمنفذ، فلا تُنقل بيانات الحساب إلى موقع آخر عند إعادة التوجيه.
15. لشهادة عميل TLS اضغط «إضافة شهادة» وحدّد أصل HTTPS وملف PFX أو P12 وعبارة مروره عند الحاجة. يبقى الملف في موقعه ويستمر التحقق من شهادة الخادم. حفظ عبارة المرور اختياري ومشفّر لحساب Windows الحالي؛ إن لم تحفظها فأدخلها بعد إعادة تشغيل سَهم. الحقل الفارغ يُبقي السر المحفوظ للأصل نفسه، وخيار الإزالة يمسحه. حذف إعداد الموقع أو الشهادة يزيل بيانات الدخول المحفوظة الخاصة به أيضًا.

16. لتحديث موقع دوريًا، فعّل خيار التحديث في نموذج «نسخ المواقع»، أو اضغط «المزامنة…» بجوار مشروع موجود. الفترة من دقيقة إلى سبعة أيام أثناء تشغيل سَهم؛ لا تتداخل دورات المشروع. تُعتمد النسخة الجديدة بعد اكتمال مواردها ضمن النطاق، وتبقى السابقة متاحة عند فشل مورد أو نفاد الحصة. افتح النسختين من أوامرهما في صف المشروع. يوقف تعديل ملف محلي التكرار ويعرض تعارضًا بدل الكتابة فوقه. فحص الآن لا يفعّل التكرار الموقوف. تبقى جميع النسخ ومجلدات الدورات المتوقفة على القرص دون حذف تلقائي؛ تحتاج المواقع الخاصة إلى دخول جديد بعد الخروج من التطبيق.
17. من قسم قواعد الخوادم في «الشبكة والوكيل»، أضف اسم نطاق أو نمطًا مثل *.example.com، ومنفذًا اختياريًا، وحدد سقف الخادم واتصالات ملف HTTP وسرعة الملف ومجلده وتصنيفه. الاسم الدقيق أولًا، ثم أطول نطاق فرعي؛ وللاسم نفسه يتقدم المنفذ المحدد. لا يشمل النمط اسم النطاق نفسه. المجلد والتصنيف للمهام الجديدة فقط، واختيار مجلد صريح للتنزيل يتقدم على مجلد القاعدة. أوقف العمل النشط قبل حفظها. الحد يحسب استجابات HTTP النشطة وعمليات نقل FTP وأنفاق CONNECT، ولا يعد المقابس الخاملة أو كل طلب داخل نفق HTTP/2؛ قناة تحكم FTP إضافية. سرعة النفق تشمل تغليف TLS.

18. لحفظ صفحات SPA ذات مسارات hash، اختر لقطة JavaScript وفعّل حفظ المسارات التي تبدأ بـ #/ أو #!/ كصفحات مستقلة. يمكن أن يتضمن رابط البداية المسار. يحفظ سَهم الروابط المكتشفة ضمن الحدود والمرشحات نفسها، ويحوّلها إلى ملفات محلية مستقلة؛ يبقى #section مرساة داخل الصفحة. لا يكتشف المسارات المخفية في كود التطبيق أو التي تتطلب ضغط أزرار، ولا يحوّل API أو قاعدة بيانات الخادم إلى خدمة دون اتصال.
19. تستخدم نافذتا دخول الموقع وعرضه إعداد NTLM أو Negotiate وشهادة PFX المضبوطين لأصل المشروع في «الشبكة والوكيل». تطابق القاعدة البروتوكول والاسم والمنفذ، وتشمل الصفحة والصور وCSS وPOST API، مع بقاء قواعد Cookie وHttpOnly وCORS في Chromium. لا تُستورد الهوية إلى مخزن Windows. حد جسم الطلب المحمي 4 MiB وحد مورد العرض 32 MiB؛ تُقرأ الاستجابة كاملة قبل عرضها. الرفع غير القابل للقراءة وWebSocket والاستجابات الحية المفتوحة غير مدعومة في هذا المسار. ما زال Kerberos يحتاج تجربة KDC فعلية، ولا يشمل الإصدار البطاقات الذكية أو اختيار شهادات مخزن Windows.

تقيس الحصة البيانات التي يمررها سَهم إلى المحركات. تُحسب أجسام استجابات HTTP وبيانات FTP، وتشمل قراءة معلومات المواقع والوسائط وحركة نافذة تسجيل الدخول وتشغيل صفحات الموقع. في YouTube ومسار متصفح المواقع العادي تُحسب البيانات الواردة عبر النفق المشفّر، ولذلك تشمل تغليف TLS في HTTPS. مسار نافذة العرض المحمي بـNTLM أو PFX يحسب أجسام الاستجابات بعد فك الضغط دون تغليف TLS. قد يحمّل المتصفح موارد قبل حفظها في النسخة، فيختلف الاستهلاك عن حجم الملفات النهائية. هذا العداد ليس عداد استهلاك الشبكة في Windows، ولا يشمل حركة التطبيقات الأخرى أو البيانات الصادرة.

20. لتنزيلات POST، حدّث الإضافة والتطبيق إلى ${version} وفعّل خيارها في الجهتين. يكمل المتصفح الاستجابة الأصلية ثم يظهر الملف المكتمل في سَهم في موقعه نفسه، دون POST جديد أو نسخة ملف ثانية. استخدم المتصفح أثناء النقل؛ حصة سَهم وقواعد سرعته ومجلده لا تدير هذا النقل. عند تعذّر الاتصال يحتفظ المتصفح بالملف وتستدرك الإضافة إضافته أثناء عمل المتصفح، ضمن سبعة أيام وحتى 128 حالة؛ تحتفظ بالمعرّف ووقت البداية فقط. الملفات غير الآمنة ومسارات UNC والأجهزة الخاصة لا تُضاف.

21. تظهر نافذة مستقلة لكل تنزيل عند بدئه، وتعرض التقدم والسرعة والوقت المتبقي ومسار الحفظ، مع الإيقاف المؤقت والاستئناف وفتح المجلد. إخفاء النافذة لا يوقف التنزيل. انقر صف المهمة مرتين لفتحها مجددًا. يمكن تعطيل الظهور التلقائي من الإعدادات؛ الحد التلقائي ثماني نوافذ معًا، ويمكن فتح غيرها يدويًا.

22. الإضافة لم تُنشر في المتاجر بعد. أزرار التثبيت من Chrome وEdge معطلة وتظل خطوات وضع المطوّر مطلوبة لهذه التجربة. جُهزت حزمة ZIP للنشر في مجلد extension ودليل EXTENSION-PUBLISHING في المصدر. بعد اعتماد الإضافة وإضافة معرفها ورابطها إلى إعداد البناء، يفتح سَهم صفحة المتجر في المتصفح المختار ليمنح المستخدم الإذن هناك. لا يُدفع اشتراك أو تُفرض إضافة على المتصفح.

يمكن تحديد الصفوف للإيقاف أو الاستئناف أو الإزالة جماعيًا، وتنظيمها في قوائم ذات مواعيد تشغيل. «إزالة» تُبقي الملفات على القرص.
تدعم الإعدادات قواعد تصنيف ومجلدات حسب الامتداد، وتشغيل سَهم مع Windows عند اختياره. فحص الملف بعد التنزيل خيار مستقل؛ تعذّر الفحص أو إلغاؤه يبقي الملف المكتمل ويعرض النتيجة، ولا يعني أن الملف اجتاز الفحص.
مراقبة الحافظة اختيارية، وتفتح الروابط المقترحة حوارًا للمراجعة قبل بدء التنزيل.
تظهر مهلة إجراء الاكتمال في سَهم حتى إذا كانت إشعارات Windows معطّلة. إغلاق النافذة يُبقي العد والتنزيلات في الخلفية؛ استخدم زر إلغاء الإجراء قبل مغادرة التطبيق إذا لم تعد تريده.
يترك Negotiate اختيار Kerberos أو NTLM إلى Windows. يحتاج Kerberos إلى إعداد نطاق وKDC واسم خدمة SPN مناسب. اختُبر NTLM وتبادل Negotiate محليًا في هذه النسخة، ولم يُختبر نطاق Kerberos فعلي؛ لذلك لا يُعد ذلك إثباتًا لتوافق جميع بيئات المؤسسات.
اختر العربية أو الإنجليزية من «لغة الواجهة» في الإعدادات ثم احفظ. تتبع اتجاهات الحقول اللغة المختارة، وتستخدم العدادات والتواريخ أرقامًا لاتينية. للإضافة اختيار لغة مستقل.

أغلق سَهم نهائيًا من «خروج» في قائمة أيقونة الساعة. راجع تقرير المقارنة لمعرفة الفجوات المتبقية؛ هذه النسخة لا تثبت تطابقًا بنسبة 100٪ مع IDM.
`;
  const guide = path.join(release, 'ابدأ-هنا.txt');
  await writeFile(guide, startHere.replaceAll('\n', '\r\n'), 'utf8');
  const splitDirectories = !samePath(path.dirname(portable), release);
  const shipped = [...(splitDirectories ? [] : portableFiles), installer, guide].sort(), checksums = [];
  for (const file of shipped) checksums.push(`${await sha256(file)}  ${slash(path.relative(release, file))}`);
  const sums = path.join(release, 'SHA256SUMS.txt');
  await writeFile(sums, checksums.join('\r\n') + '\r\n', 'utf8');
  let portableSums = sums;
  if (splitDirectories) {
    portableSums = path.join(path.dirname(portable), 'SHA256SUMS-portable.txt');
    const portableChecksums = [];
    for (const file of portableFiles) portableChecksums.push(`${await sha256(file)}  ${slash(path.relative(path.dirname(portable), file))}`);
    await writeFile(portableSums, portableChecksums.join('\r\n') + '\r\n', 'utf8');
  }
  report = {
    checkedAt: new Date().toISOString(), canonicalSource, installer, bytes: (await stat(installer)).size,
    sha256: await sha256(installer), builder: 'electron-builder / NSIS x64',
    embeddedPayloadIntegrity: 'passed: Everything is Ok',
    archiveNote: '7-Zip validates the embedded 7z payload at an offset; outer NSIS code is not executed.',
    applicationVersion: version, extensionVersion: version, appAsarSha256: await sha256(archive),
    appAsarMatchesCanonicalSource: true, allExtractedPayloadFilesMatchPortable: true,
    portableFilesChecked: portableFiles.length, sourceFilesChecked: sourceFiles.length, sourceFiles,
    requiredPayloadEntries: required, runtimeFiles, installationExecuted: false, personalBrowserRegistrationsChanged: false,
    portable, startHere: guide, checksums: sums, portableChecksums: portableSums,
  };
  await writeFile(path.join(artifactDirectory, `sahm-${artifactVersion}-installer-verification.json`), JSON.stringify(report, null, 2));
} finally {
  const extractionPath = await realpath(extracted);
  assert.equal(path.dirname(extractionPath).toLowerCase(), realParent.toLowerCase());
  assert.ok(path.basename(extractionPath).startsWith('verify-'));
  await rm(extractionPath, { recursive: true, force: true });
}
console.log(JSON.stringify({ installer: report.installer, bytes: report.bytes, sha256: report.sha256, appAsarSha256: report.appAsarSha256, portableFilesChecked: report.portableFilesChecked, sourceFilesChecked: report.sourceFilesChecked, runtimeFiles: report.runtimeFiles.length }, null, 2));
