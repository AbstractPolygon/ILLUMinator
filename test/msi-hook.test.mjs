// The Windows .msi "Add to desktop" option: build/msi-hook.cjs patches electron-builder's generated project.wxs.
// WiX cannot run here, so this renders the real electron-builder template (as MsiTarget does), applies the patch and
// checks the result is well-formed and wired up; the Windows CI job installs the built .msi to check the behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { patchProject } = require('../build/msi-hook.cjs');
const templatePath = 'node_modules/app-builder-lib/templates/msi/template.xml';
const have = existsSync(templatePath);

function render(opts) {
  const ejs = require('ejs');
  const tpl = readFileSync(templatePath, 'utf8').replace(/{{/g, '<%').replace(/}}/g, '%>').replace(/\${([^}]+)}/g, '<%=$1%>');
  const files =
    '<Component>\n      <File Name="Illuminator.exe" Source="$(var.appDir)\\Illuminator.exe" ReadOnly="yes" KeyPath="yes" Id="mainExecutable">\n' +
    (opts.desktop ? '        <Shortcut Id="desktopShortcut" Directory="DesktopFolder" Name="Illuminator" WorkingDirectory="APPLICATIONFOLDER" Advertise="yes" Icon="icon.ico"/>\n' : '') +
    '        <Shortcut Id="startMenuShortcut" Directory="ProgramMenuFolder" Name="Illuminator" WorkingDirectory="APPLICATIONFOLDER" Advertise="yes" Icon="icon.ico"/>\n' +
    '      </File></Component>';
  return ejs.compile(tpl)({
    productName: 'Illuminator', upgradeCode: '00000000-0000-0000-0000-000000000000', version: '0.5.71.0', manufacturer: 'Illuminator',
    compressionLevel: 'high', installationDirectoryWixName: 'Illuminator', iconPath: 'C:\\icon.ico', iconId: 'icon.ico',
    isRunAfterFinish: true, isAssisted: opts.assisted, isPerMachine: true, isCreateDesktopShortcut: opts.desktop,
    isCreateStartMenuShortcut: true, menuCategory: null, programFilesId: 'ProgramFiles64Folder', dirs: '', files,
  });
}

function wellFormed(xml) {
  const parser = require('sax').parser(true); // strict: throws on the first error
  parser.write(xml).close();
}

for (const desktop of [false, true]) {
  test(`msi hook patches the assisted installer project (template desktop shortcut ${desktop})`, { skip: !have }, () => {
    const out = patchProject(render({ assisted: true, desktop }));
    wellFormed(out);
    // electron-builder's advertised shortcut is gone: the shortcut is made by a custom action at the end of the install
    assert.doesNotMatch(out, /Id="desktopShortcut"/);
    assert.doesNotMatch(out, /DesktopOptionDlg/);
    assert.match(out, /<Property Id="ADDTODESKTOP" Secure="yes" Value="1"\/>/);
    const create = /<CustomAction Id="CreateDesktopShortcut"[^>]*ExeCommand="([^"]*)"[^>]*Execute="immediate"/.exec(out);
    assert.ok(create, 'create action');
    const command = create[1].replace(/&quot;/g, '"');
    assert.match(command, /powershell\.exe" -NoProfile/);
    assert.match(command, /TargetPath='\[#mainExecutable\]'/);
    // `[` and `]` start a property reference in a command line, so the only ones are the file and folder references
    assert.deepEqual([...command.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]), ['SystemFolder', '#mainExecutable', 'APPLICATIONFOLDER']);
    assert.match(out, /<CustomAction Id="RemoveDesktopShortcut"[^>]*Execute="deferred" Impersonate="yes"/);
    // silent installs make it, with ADDTODESKTOP=0 they do not; the wizard's Finish button makes it for the checkbox
    assert.match(out, /<Custom Action="CreateDesktopShortcut" After="InstallFinalize">ADDTODESKTOP = 1 AND NOT Installed AND UILevel &lt; 5<\/Custom>/);
    assert.match(out, /<Custom Action="RemoveDesktopShortcut" Before="RemoveFiles">REMOVE="ALL"<\/Custom>/);
    assert.match(out, /<Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="CreateDesktopShortcut" Order="2">ADDTODESKTOP = 1 AND NOT Installed<\/Publish>/);
    // the start menu shortcut is untouched
    assert.match(out, /Id="startMenuShortcut"/);
    // idempotent
    assert.equal(patchProject(out), out);
  });
}

test('msi hook on a one-click project makes the shortcut in the install, with no wizard to ask', { skip: !have }, () => {
  const out = patchProject(render({ assisted: false, desktop: false }));
  wellFormed(out);
  assert.match(out, /<Custom Action="CreateDesktopShortcut" After="InstallFinalize">ADDTODESKTOP = 1 AND NOT Installed<\/Custom>/);
  assert.doesNotMatch(out, /Dialog="ExitDialog"[^>]*Value="CreateDesktopShortcut"/);
});

// The checkbox itself is added to the built package (WiX cannot add a control to a stock dialog): on Linux with msitools, which
// reads the same SQL as Windows Installer's COM interface does.
const msibuild = spawnSync('msibuild', ['--help']).status !== null && spawnSync('msibuild', ['--help']).error === undefined;
test('msi-finish adds the desktop checkbox to the Finish page', { skip: !msibuild }, () => {
  const finish = require('../build/msi-finish.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'msi-finish-'));
  try {
    writeFileSync(join(dir, 'Control.idt'), 'Dialog_\tControl\tType\tX\tY\tWidth\tHeight\tAttributes\tProperty\tText\tControl_Next\tHelp\ns72\ts50\ts20\ti2\ti2\ti2\ti2\ti4\tS50\tL0\tS50\tL50\nControl\tDialog_\tControl\nExitDialog\tFinish\tPushButton\t236\t243\t56\t17\t3\t\tFinish\t\t\n');
    writeFileSync(join(dir, 'CheckBox.idt'), 'Property\tValue\ns72\tS64\nCheckBox\tProperty\n');
    const msi = join(dir, 'test.msi');
    assert.equal(spawnSync('msibuild', [msi, '-i', join(dir, 'Control.idt'), join(dir, 'CheckBox.idt')]).status, 0);
    const q = (sql) => spawnSync('msibuild', [msi, '-q', sql], { encoding: 'utf8' });
    assert.equal(q(finish.EXISTS).status, 0);
    for (const sql of finish.statements()) { const r = q(sql); assert.equal(r.status, 0, `${sql}\n${r.stderr}`); }
    const dump = spawnSync('msidump', ['-t', msi], { encoding: 'utf8', cwd: dir });
    assert.equal(dump.status, 0, dump.stderr);
    const rows = readFileSync(join(dir, 'Control.idt'), 'utf8').split('\n');
    const row = rows.find((r) => r.startsWith('ExitDialog\tDesktopCheck\t'));
    assert.ok(row, 'the checkbox row');
    const c = row.split('\t');
    assert.deepEqual(c.slice(2, 10), ['CheckBox', '135', '170', '220', '18', String(3 + 0x10000), 'ADDTODESKTOP', 'Add Illuminator to the desktop']);
    assert.match(readFileSync(join(dir, 'CheckBox.idt'), 'utf8'), /ADDTODESKTOP\t1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('package.json wires the hook and leaves the shortcut to it', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.build.msiProjectCreated, './build/msi-hook.cjs');
  assert.equal(pkg.build.msi.createDesktopShortcut, false);
  assert.ok(existsSync('build/msi-hook.cjs'));
  assert.equal(pkg.build.afterAllArtifactBuild, './build/msi-finish.cjs');
  assert.ok(existsSync('build/msi-finish.cjs'));
});
