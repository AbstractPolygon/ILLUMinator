'use strict';
// electron-builder `msiProjectCreated` hook: gives the Windows .msi an "Add to desktop" checkbox.
//
// electron-builder's MSI always (or never) creates the desktop shortcut, as an advertised shortcut inside the
// main executable's component, and its WixUI_InstallDir dialog set has no page for it. This patches the generated
// project.wxs so that
//   * the desktop shortcut lives in its own component, installed only when the public property ADDTODESKTOP is 1;
//   * ADDTODESKTOP defaults to 1 and is shown as a checkbox on a new page between "Destination Folder" and "Ready
//     to install" (silent installs: `msiexec /i Illuminator.msi ADDTODESKTOP=0 /qn` leaves the desktop alone).
// The patch is a pure string transform (patchProject) so it can be unit-tested without WiX.

const fs = require('fs');

const DIALOG = 'DesktopOptionDlg';

function attr(xml, tag, name) {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
}

function patchProject(xml) {
  if (xml.includes(`Id="${DIALOG}"`)) return xml; // already patched

  const productName = attr(xml, 'Product', 'Name') || 'Illuminator';
  const iconId = attr(xml, 'Icon', 'Id');
  const hasUi = /<UIRef\s+Id="WixUI_InstallDir"/.test(xml);

  // 1. Drop electron-builder's own (advertised) desktop shortcut; we re-add it as a conditional component.
  xml = xml.replace(/[ \t]*<Shortcut\s+Id="desktopShortcut"[^>]*\/>[ \t]*\r?\n?/, '');

  // 2. The Desktop folder, unless the template already declared it.
  if (!/<Directory\s+Id="DesktopFolder"/.test(xml)) {
    xml = xml.replace(/(<Directory\s+Id="TARGETDIR"[^>]*>)/, '$1\n      <Directory Id="DesktopFolder" Name="Desktop"/>');
  }

  // 3. The conditional component. Not an advertised shortcut: it points at the installed exe, so it can sit in its own
  //    component, and a registry value is its key path (a shortcut cannot be one).
  const icon = iconId ? ` Icon="${iconId}"` : '';
  const component =
    '      <Component Id="DesktopShortcutComponent" Directory="DesktopFolder" Guid="*">\n' +
    '        <Condition>ADDTODESKTOP = 1</Condition>\n' +
    `        <Shortcut Id="desktopShortcut" Name="${productName}" Target="[#mainExecutable]" WorkingDirectory="APPLICATIONFOLDER"${icon}/>\n` +
    `        <RegistryValue Root="HKMU" Key="Software\\${productName}" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes"/>\n` +
    '      </Component>\n';
  xml = xml.replace(/([ \t]*)<\/ComponentGroup>(?![\s\S]*<\/ComponentGroup>)/, `${component}$1</ComponentGroup>`);

  // 4. The property and (for the assisted installer) the page.
  let extra = '    <Property Id="ADDTODESKTOP" Secure="yes" Value="1"/>\n';
  if (hasUi) {
    extra +=
      '    <UI>\n' +
      `      <Dialog Id="${DIALOG}" Width="370" Height="270" Title="[ProductName] Setup">\n` +
      '        <Control Id="Next" Type="PushButton" X="236" Y="243" Width="56" Height="17" Default="yes" Text="!(loc.WixUINext)"/>\n' +
      '        <Control Id="Back" Type="PushButton" X="180" Y="243" Width="56" Height="17" Text="!(loc.WixUIBack)"/>\n' +
      '        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Cancel="yes" Text="!(loc.WixUICancel)">\n' +
      '          <Publish Event="SpawnDialog" Value="CancelDlg">1</Publish>\n' +
      '        </Control>\n' +
      '        <Control Id="BannerBitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="44" TabSkip="no" Text="!(loc.InstallDirDlgBannerBitmap)"/>\n' +
      '        <Control Id="BannerLine" Type="Line" X="0" Y="44" Width="370" Height="0"/>\n' +
      '        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0"/>\n' +
      '        <Control Id="Title" Type="Text" X="15" Y="6" Width="300" Height="15" Transparent="yes" NoPrefix="yes" Text="{\\WixUI_Font_Title}Shortcuts"/>\n' +
      '        <Control Id="Description" Type="Text" X="25" Y="23" Width="340" Height="15" Transparent="yes" NoPrefix="yes" Text="Choose where Setup puts shortcuts to [ProductName]."/>\n' +
      '        <Control Id="DesktopCheck" Type="CheckBox" X="20" Y="60" Width="330" Height="18" Property="ADDTODESKTOP" CheckBoxValue="1" Text="Add to desktop"/>\n' +
      '      </Dialog>\n' +
      // WixUI_InstallDir publishes its own NewDialog -> VerifyReadyDlg at Order 3; a later Order wins.
      '      <Publish Dialog="InstallDirDlg" Control="Next" Event="NewDialog" Value="' + DIALOG + '" Order="4">WIXUI_DONTVALIDATEPATH OR WIXUI_INSTALLDIR_VALID="1"</Publish>\n' +
      `      <Publish Dialog="${DIALOG}" Control="Back" Event="NewDialog" Value="InstallDirDlg">1</Publish>\n` +
      `      <Publish Dialog="${DIALOG}" Control="Next" Event="NewDialog" Value="VerifyReadyDlg">1</Publish>\n` +
      `      <Publish Dialog="VerifyReadyDlg" Control="Back" Event="NewDialog" Value="${DIALOG}" Order="3">NOT Installed</Publish>\n` +
      '    </UI>\n';
  }
  xml = xml.replace(/([ \t]*)<\/Product>/, `${extra}$1</Product>`);
  return xml;
}

module.exports = async function msiProjectCreated(projectFile) {
  const xml = fs.readFileSync(projectFile, 'utf8');
  const out = patchProject(xml);
  if (out === xml) throw new Error('msi-hook: project.wxs was not changed');
  fs.writeFileSync(projectFile, out);
};
module.exports.patchProject = patchProject;
