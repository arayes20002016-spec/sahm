import { extractFile } from '@electron/asar';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GiB, prepareBuildStorage } from './lib/build-storage.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
const output = process.env.SAHM_RELEASE_DIRECTORY ? path.resolve(process.env.SAHM_RELEASE_DIRECTORY) : path.join(projectDir, 'dist', version);
const prepackaged = process.env.SAHM_PORTABLE_DIRECTORY ? path.resolve(process.env.SAHM_PORTABLE_DIRECTORY) : path.join(output, 'SAHM-win32-x64');
await access(path.join(prepackaged, 'SAHM.exe'));
const appArchive = path.join(prepackaged, 'resources', 'app.asar');
const archiveExists = await stat(appArchive).then(result => result.isFile(), error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const packaged = JSON.parse(archiveExists
  ? extractFile(appArchive, 'package.json').toString('utf8')
  : await readFile(path.join(prepackaged, 'resources', 'app', 'package.json'), 'utf8'));
if (packaged.version !== version) throw new Error('أعد بناء حزمة سَهم الحالية قبل إنشاء المثبّت.');

const temporary = await prepareBuildStorage({ output, outputBytes: GiB / 2 });
process.env.TEMP = temporary;
process.env.TMP = temporary;
const { build, Platform, Arch } = await import('app-builder-lib');

await build({
  projectDir,
  prepackaged,
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.sahm.downloadmanager',
    productName: 'SAHM',
    artifactName: 'SAHM-Setup-${version}.${ext}',
    directories: { output, buildResources: 'build' },
    win: {
      icon: 'assets/sahm.ico',
      executableName: 'SAHM',
      requestedExecutionLevel: 'asInvoker',
      signAndEditExecutable: false
    },
    nsis: {
      include: 'build/win-installer.nsh',
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      selectPerMachineByDefault: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'سَهم',
      uninstallDisplayName: 'سَهم — SAHM',
      installerIcon: 'assets/sahm.ico',
      uninstallerIcon: 'assets/sahm.ico',
      installerLanguages: ['ar_SA', 'en_US'],
      displayLanguageSelector: true,
      language: '1025',
      unicode: true,
      differentialPackage: false,
      packElevateHelper: false,
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
      warningsAsErrors: true
    }
  }
});

const installer = path.join(output, `SAHM-Setup-${version}.exe`);
const result = await stat(installer);
if (!result.isFile() || result.size < 1024) throw new Error('لم يُنشأ ملف التثبيت.');
console.log(installer);
