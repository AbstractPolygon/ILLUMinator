'use strict';
// electron-builder `afterAllArtifactBuild` hook: puts the "Add to desktop" checkbox on the last page of the .msi wizard
// ("Completing the Illuminator Setup Wizard").
//
// That page (WixUI's ExitDialog) has one optional checkbox, which electron-builder uses for "Run Illuminator", and WiX cannot
// add a control to a stock dialog. So this adds the checkbox to the built package's Control table, with Windows Installer's own
// database API (PowerShell + COM, as the CI check does), and build/msi-hook.cjs makes the Finish button act on it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIALOG = 'ExitDialog';
const CONTROL = 'DesktopCheck';

// The stock page: title at y 20-80, description 70-110, the optional ("Run ...") checkbox at y 190, the bottom line at 234; the desktop checkbox sits right above it (y 170) so the two read as one group.
const CHECKBOX_TEXT = 'Add Illuminator to the desktop';
// Visible + Enabled + Transparent (the page has a picture behind it).
const ATTRIBUTES = 3 + 0x10000;

// [existence check, statements]
function statements() {
  return [
    `INSERT INTO \`Control\` (\`Dialog_\`, \`Control\`, \`Type\`, \`X\`, \`Y\`, \`Width\`, \`Height\`, \`Attributes\`, \`Property\`, \`Text\`) VALUES ('${DIALOG}', '${CONTROL}', 'CheckBox', 135, 170, 220, 18, ${ATTRIBUTES}, 'ADDTODESKTOP', '${CHECKBOX_TEXT}')`,
    // The value a ticked box sets (WiX writes this row for CheckBoxValue="1").
    "INSERT INTO `CheckBox` (`Property`, `Value`) VALUES ('ADDTODESKTOP', '1')",
  ];
}
const EXISTS = `SELECT \`Control\` FROM \`Control\` WHERE \`Dialog_\`='${DIALOG}' AND \`Control\`='${CONTROL}'`;
const HAS_VALUE = "SELECT `Value` FROM `CheckBox` WHERE `Property`='ADDTODESKTOP'";

const PS = `
param($msi, $json)
$sql = Get-Content -Raw -LiteralPath $json | ConvertFrom-Json
$wi = New-Object -ComObject WindowsInstaller.Installer
$db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @($msi, 1))
function Run($q) {
  $v = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($q))
  $v.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $v, $null) | Out-Null
  $n = 0
  if ($q -like 'SELECT*') { while ($v.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $v, $null)) { $n++ } }
  $v.GetType().InvokeMember('Close', 'InvokeMethod', $null, $v, $null) | Out-Null
  return $n
}
if ((Run $sql.exists) -eq 0) {
  Run $sql.statements[0] | Out-Null
  if ((Run $sql.hasValue) -eq 0) { Run $sql.statements[1] | Out-Null }
  $db.GetType().InvokeMember('Commit', 'InvokeMethod', $null, $db, $null) | Out-Null
  Write-Host 'added the desktop checkbox'
} else { Write-Host 'the desktop checkbox is already there' }
`;

function addCheckbox(msi) {
  if (process.platform !== 'win32') {
    console.warn(`msi-finish: ${msi} left as is (the checkbox is added on Windows)`);
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msi-finish-'));
  const ps1 = path.join(dir, 'add.ps1');
  const json = path.join(dir, 'sql.json');
  fs.writeFileSync(ps1, PS);
  const [insertControl, insertValue] = statements();
  fs.writeFileSync(json, JSON.stringify({ exists: EXISTS, hasValue: HAS_VALUE, statements: [insertControl, insertValue] }));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, msi, json], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`msi-finish: adding the checkbox to ${msi} failed: ${r.stderr || r.stdout}`);
  console.log(`msi-finish: ${r.stdout.trim()} (${msi})`);
  return true;
}

module.exports = async function afterAllArtifactBuild(result) {
  for (const f of (result && result.artifactPaths) || []) if (/\.msi$/i.test(f)) addCheckbox(f);
  return [];
};
Object.assign(module.exports, { statements, EXISTS, HAS_VALUE, addCheckbox, DIALOG, CONTROL });
