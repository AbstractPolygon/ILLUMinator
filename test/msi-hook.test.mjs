// The Windows .msi "Add to desktop" option: build/msi-hook.cjs patches electron-builder's generated project.wxs.
// WiX cannot run here, so this renders the real electron-builder template (as MsiTarget does), applies the patch and
// checks the result is well-formed and wired up; the Windows CI job installs the built .msi to check the behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

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
    // the advertised shortcut is gone, replaced by exactly one conditional component with a registry key path
    assert.equal(out.match(/Id="desktopShortcut"/g).length, 1);
    assert.doesNotMatch(out, /Advertise="yes" Icon="icon.ico"\/>\s*<Shortcut Id="startMenuShortcut"[\s\S]*desktopShortcut/);
    assert.match(out, /<Component Id="DesktopShortcutComponent" Directory="DesktopFolder" Guid="\*">\s*<Condition>ADDTODESKTOP = 1<\/Condition>/);
    assert.match(out, /<RegistryValue Root="HKCU"[^>]*KeyPath="yes"\/>/);
    assert.match(out, /Target="\[#mainExecutable\]"/);
    // the start menu shortcut is untouched
    assert.match(out, /Id="startMenuShortcut"/);
    // exactly one DesktopFolder directory, the property defaults to ticked
    assert.equal(out.match(/<Directory Id="DesktopFolder"/g).length, 1);
    assert.match(out, /<Property Id="ADDTODESKTOP" Secure="yes" Value="1"\/>/);
    // the dialog and its navigation: InstallDirDlg -> DesktopOptionDlg -> VerifyReadyDlg and back
    assert.match(out, /<Dialog Id="DesktopOptionDlg"/);
    assert.match(out, /Type="CheckBox"[^>]*Property="ADDTODESKTOP"[^>]*CheckBoxValue="1"[^>]*Text="Add to desktop"/);
    assert.match(out, /Dialog="InstallDirDlg" Control="Next" Event="NewDialog" Value="DesktopOptionDlg" Order="4"/);
    assert.match(out, /Dialog="DesktopOptionDlg" Control="Back" Event="NewDialog" Value="InstallDirDlg"/);
    assert.match(out, /Dialog="DesktopOptionDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg"/);
    assert.match(out, /Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="DesktopOptionDlg"/);
    // the component sits in the product component group, inside the feature
    assert.ok(out.indexOf('DesktopShortcutComponent') < out.indexOf('</ComponentGroup>'));
    // idempotent
    assert.equal(patchProject(out), out);
  });
}

test('msi hook on a one-click project adds the property and component but no dialog', { skip: !have }, () => {
  const out = patchProject(render({ assisted: false, desktop: false }));
  wellFormed(out);
  assert.match(out, /DesktopShortcutComponent/);
  assert.doesNotMatch(out, /DesktopOptionDlg/);
});

test('package.json wires the hook and leaves the shortcut to it', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.build.msiProjectCreated, './build/msi-hook.cjs');
  assert.equal(pkg.build.msi.createDesktopShortcut, false);
  assert.ok(existsSync('build/msi-hook.cjs'));
});
