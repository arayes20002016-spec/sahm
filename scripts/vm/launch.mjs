import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectQmp } from './qmp.mjs';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const root = resolve(process.argv[2] || 'E:/SAHM-Releases/vm-0.14-smoke');
const phase = process.argv[3] || 'provision';
const virtualCpus = Number(process.env.SAHM_VM_CPUS || 1);
const machine = process.env.SAHM_VM_MACHINE || 'q35,smm=off';
assert.ok(['q35,smm=off', 'q35,pic=off,smm=off'].includes(machine), 'Unsupported VM machine configuration');
assert.ok(Number.isInteger(virtualCpus) && virtualCpus >= 1 && virtualCpus <= 2, 'VM CPU allocation must be 1 or 2');
assert.match(phase, /^[a-z0-9-]+$/);
const diskMedia = process.argv.includes('--disk-media');
assert.ok(!diskMedia || phase !== 'provision', 'Windows provisioning requires the removable answer-file media');
const mediaRoot = resolve(process.env.SAHM_VM_CACHE_DIRECTORY || join(process.env.LOCALAPPDATA, 'SAHM-VM-Lab/media'));
let mediaGeneration = null;
let candidateBinding = null;
const media = [];
if (diskMedia) {
  const generationInfo = JSON.parse(await readFile(join(mediaRoot, 'generation.json'), 'utf8'));
  mediaGeneration = generationInfo.generation;
  assert.match(mediaGeneration, /^[a-f0-9]{16}$/);
  for (const [id, name, bus] of [['payload', 'payload.img', 'ide.1'], ['testtools', 'tools.img', 'ide.3']]) {
    const file = join(mediaRoot, name); await stat(file);
    media.push('-drive', 'file=' + file.replaceAll('\\', '/') + ',format=raw,if=none,id=' + id + ',snapshot=on', '-device', 'ide-hd,drive=' + id + ',bus=' + bus);
  }
  const configuration = JSON.parse((await readFile(join(generationInfo.payloadDirectory, 'test-phase.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.match(configuration.candidate.version, /^\d+\.\d+\.\d+$/);
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const candidateDirectory = resolve(process.env.SAHM_VM_CANDIDATE_DIRECTORY || join(project, 'dist', configuration.candidate.version));
  const portableDirectory = join(candidateDirectory, 'SAHM-win32-x64');
  candidateBinding = {
    version: configuration.candidate.version,
    installerSha256: await sha256(join(candidateDirectory, 'SAHM-Setup-' + configuration.candidate.version + '.exe')),
    appAsarSha256: await sha256(join(portableDirectory, 'resources/app.asar')),
    executableSha256: await sha256(join(portableDirectory, 'SAHM.exe')),
  };
  assert.equal(candidateBinding.installerSha256, configuration.candidate.sha256, 'VM candidate installer binding is stale');
  assert.equal(candidateBinding.appAsarSha256, configuration.expectedAppAsarSha256, 'VM candidate application archive binding is stale');
  assert.equal(candidateBinding.executableSha256, configuration.expectedExecutableSha256, 'VM candidate executable binding is stale');
} else {
  media.push('-device', 'ich9-usb-ehci1,id=ehci');
  for (const [id, folder] of [['payload', 'payload'], ...(phase === 'provision' ? [] : [['testtools', 'tools-payload']])]) {
    media.push('-drive', 'file=fat:ro:' + join(root, folder).replaceAll('\\', '/') + ',format=raw,if=none,id=' + id + ',readonly=on', '-device', 'usb-storage,bus=ehci.0,drive=' + id + ',removable=on');
  }
}
const iso = join(process.env.LOCALAPPDATA, 'SAHM-VM-Lab/isos/windows-10-enterprise-ltsc-2021-eval-x64.iso');
const disk = process.env.SAHM_VM_DISK ? resolve(process.env.SAHM_VM_DISK) : join(root, 'windows.qcow2');
const resultDisk = process.env.SAHM_VM_RESULT_DISK ? resolve(process.env.SAHM_VM_RESULT_DISK) : null;
if (resultDisk) {
  assert.ok(resultDisk.toLowerCase().startsWith(root.toLowerCase() + '\\'), 'Result disk must stay in this owned VM lab');
  assert.ok((await stat(resultDisk)).isFile());
  media.push('-drive', 'file=' + resultDisk.replaceAll('\\', '/') + ',format=raw,if=none,id=qaresults', '-device', 'ide-hd,drive=qaresults,bus=ide.4');
}
const executable = join(root, 'tools/qemu/qemu-system-x86_64.exe');
assert.equal((await stat(iso)).size, 4898582528);
const isoSha256 = await sha256(iso);
assert.equal(isoSha256, 'e4ab2e3535be5748252a8d5d57539a6e59be8d6726345ee10e7afd2cb89fefb5');
await stat(disk); await stat(executable); await mkdir(root, { recursive: true });
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const args = ['-name', 'SAHM QA VM', '-device', 'qemu-xhci,id=qa-usb', '-device', 'usb-kbd,bus=qa-usb.0', '-device', 'usb-tablet,bus=qa-usb.0', '-machine', machine, '-accel', 'whpx', '-cpu', 'Nehalem', '-m', '2048', '-smp', String(virtualCpus), '-no-reboot',
  '-drive', 'if=pflash,format=raw,unit=0,readonly=on,file=' + join(root, 'tools/qemu/share/edk2-x86_64-code.fd').replaceAll('\\', '/'),
  '-drive', 'if=pflash,format=raw,unit=1,file=' + join(root, 'uefi-vars.fd').replaceAll('\\', '/'),
  '-smbios', 'type=1,manufacturer=SAHM-QA-VM,product=SAHM-QA-QEMU,serial=SAHMTESTONLY',
  '-drive', 'file=' + disk.replaceAll('\\', '/') + ',format=qcow2,if=none,id=osdisk',
  '-device', 'ide-hd,drive=osdisk,bus=ide.0,bootindex=' + (phase === 'provision' ? '2' : '1'),
  '-drive', 'file=' + iso.replaceAll('\\', '/') + ',media=cdrom,format=raw,if=none,id=installiso,readonly=on',
  '-device', 'ide-cd,drive=installiso,bus=ide.2,bootindex=' + (phase === 'provision' ? '1' : '2'),
  ...media, '-boot', phase === 'provision' ? 'once=d,order=c' : 'order=c',
  '-display', 'none', '-vga', 'std', '-nic', 'none', '-monitor', 'none',
  '-serial', 'file:' + join(root, phase + '-serial.log').replaceAll('\\', '/'), '-qmp', 'tcp:127.0.0.1:' + port + ',server=on,wait=off'];
const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; appendFile(join(root, phase + '-stderr.log'), chunk).catch(() => {}); }); child.stdout.resume();
const report = { phase, root, disk, pid: child.pid, port, isoSha256, candidateBinding, accelerator: 'whpx', machine, guestRamMiB: 2048, virtualCpus, testMedia: diskMedia ? 'private-disk-snapshots' : 'readonly-usb', mediaGeneration, resultDisk, resultTransport: resultDisk ? 'private-fat-result-disk' : 'serial', externalNetwork: false, writableHostShares: false, startedAt: new Date().toISOString(), operatingSystemSettingsChanged: false };
await writeFile(join(root, 'active.json'), JSON.stringify(report, null, 2));
console.log('VM_STARTED ' + JSON.stringify(report));
const watchdog = setTimeout(async () => { try { const qmp = await connectQmp(port); await qmp.command('system_powerdown'); qmp.close(); } catch {} }, 45 * 60 * 1000);
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
clearTimeout(watchdog);
report.exitCode = code; report.stderr = stderr; report.finishedAt = new Date().toISOString();
await writeFile(join(root, phase + '-process.json'), JSON.stringify(report, null, 2));
console.log('VM_EXIT ' + code);
if (code !== 0) process.exitCode = 1;
