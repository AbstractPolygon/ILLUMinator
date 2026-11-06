'use strict';
// electron-builder `msiProjectCreated` hook: the Windows .msi's "Add to desktop" option.
//
// electron-builder's MSI always (or never) creates the desktop shortcut, as an advertised shortcut inside the main
// executable's component, and its WixUI_InstallDir dialogs have no checkbox for it. This patches the generated project.wxs so that
//   * the shortcut is made by a custom action when the public property ADDTODESKTOP is 1 (the default) and removed on uninstall;
//   * with the wizard, the Finish button makes it (the checkbox on the "Completing the setup wizard" page is added to the built
//     package by build/msi-finish.cjs); silent installs make it unless `msiexec /i Illuminator.msi ADDTODESKTOP=0 /qn`.
// The patch is a pure string transform (patchProject) so it can be unit-tested without WiX.

const fs = require('fs');

function attr(xml, tag, name) {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
}

// The shortcut is made by a small PowerShell command (a custom action), not by an installed component: the choice is made
// on the last page of the wizard, after the files are installed, and Windows Installer cannot add a component then.
// `[` and `]` start a property reference in a custom action's command line, so the command has none.
function shortcutCommand(productName) {
  const lnk = `$w.SpecialFolders.Item('Desktop')+'\\${productName}.lnk'`;
  const create = `$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${lnk});$s.TargetPath='[#mainExecutable]';$s.WorkingDirectory='[APPLICATIONFOLDER]';$s.Save()`;
  const remove = `$w=New-Object -ComObject WScript.Shell;Remove-Item -LiteralPath (${lnk}) -ErrorAction SilentlyContinue`;
  const run = (c) => `&quot;[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe&quot; -NoProfile -NonInteractive -WindowStyle Hidden -Command &quot;${c}&quot;`;
  return { create: run(create), remove: run(remove) };
}

function patchProject(xml) {
  if (xml.includes('Id="CreateDesktopShortcut"')) return xml; // already patched

  const productName = attr(xml, 'Product', 'Name') || 'Illuminator';
  const hasUi = /<UIRef\s+Id="WixUI_InstallDir"/.test(xml);
  const cmd = shortcutCommand(productName);

  // 1. Drop electron-builder's own (advertised) desktop shortcut; ours is made at the end of the install.
  xml = xml.replace(/[ \t]*<Shortcut\s+Id="desktopShortcut"[^>]*\/>[ \t]*\r?\n?/, '');

  // 2. The property: ticked by default. The checkbox on the "Completing the setup wizard" page (added to the built package by
  //    build/msi-finish.cjs, as WiX cannot add a control to a stock dialog) sets it; silent installs: ADDTODESKTOP=0 leaves the desktop alone.
  let extra =
    '    <Property Id="ADDTODESKTOP" Secure="yes" Value="1"/>\n' +
    `    <CustomAction Id="CreateDesktopShortcut" Directory="TARGETDIR" ExeCommand="${cmd.create}" Execute="immediate" Return="ignore"/>\n` +
    `    <CustomAction Id="RemoveDesktopShortcut" Directory="TARGETDIR" ExeCommand="${cmd.remove}" Execute="deferred" Impersonate="yes" Return="ignore"/>\n` +
    '    <InstallExecuteSequence>\n' +
    // With a wizard the Finish button does it (below); without one (silent, or a package with no dialogs) the install does.
    `      <Custom Action="CreateDesktopShortcut" After="InstallFinalize">ADDTODESKTOP = 1 AND NOT Installed${hasUi ? ' AND UILevel &lt; 5' : ''}</Custom>\n` +
    '      <Custom Action="RemoveDesktopShortcut" Before="RemoveFiles">REMOVE="ALL"</Custom>\n' +
    '    </InstallExecuteSequence>\n';
  if (hasUi) {
    extra +=
      '    <UI>\n' +
      '      <Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="CreateDesktopShortcut" Order="2">ADDTODESKTOP = 1 AND NOT Installed</Publish>\n' +
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
