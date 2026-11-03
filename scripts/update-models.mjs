// Keeps the optional upscaling models (models/) up to date with their source.
//   node scripts/update-models.mjs --check    compare models/manifest.json with the source repository; exit 1 when a model differs
//   node scripts/update-models.mjs --update   download what differs, verify it and rewrite models/*.onnx, models/manifest.json and app/js/core/upscalemodels-data.js
//   node scripts/update-models.mjs --converted  only the models converted here (manifest "converted": no ONNX at their source, made by scripts/convert-span.py from the
//                                              source's weights): exit 3 when the weights changed at the source and the model needs converting again by hand
// The source is the Hugging Face repository that holds ONNX exports of the official Real-ESRGAN weights (manifest.source). A changed file is accepted only when its size
// and SHA-256 equal what the source's own file listing says, and only while the repository's licence is still BSD-3-Clause.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'models', 'manifest.json');
const dataPath = path.join(root, 'app', 'js', 'core', 'upscalemodels-data.js');
const mode = process.argv.includes('--update') ? 'update' : 'check';
const convertedOnly = process.argv.includes('--converted');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const { repo } = manifest.source;

async function json(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'illuminator-models' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// The models converted here: has the weights file they were converted from changed at its source?
let drift = 0;
for (const model of manifest.models.filter((m) => m.converted)) {
  const from = model.converted.from;
  const tree = await json(`https://huggingface.co/api/models/${from.repo}/tree/main`);
  const entry = tree.find((f) => f.path === from.file);
  if (!entry || !entry.lfs) {
    console.log(`${model.id}: ${from.file} is no longer at ${from.repo}`);
    drift++;
  } else if (entry.lfs.oid !== from.sha256) {
    console.log(`${model.id}: the weights changed at ${from.repo} (${from.sha256.slice(0, 8)} -> ${entry.lfs.oid.slice(0, 8)}): convert them again (${model.converted.script}) and update models/manifest.json by hand`);
    drift++;
  } else {
    console.log(`${model.id}: weights unchanged at ${from.repo}`);
  }
}
if (convertedOnly) process.exit(drift ? 3 : 0);

const info = await json(`https://huggingface.co/api/models/${repo}`);
const license = info.cardData && info.cardData.license;
if (license !== manifest.source.license.toLowerCase()) throw new Error(`The source's licence is now "${license}", not ${manifest.source.license}: not updating; check it by hand (${manifest.source.card}).`);
const tree = await json(`https://huggingface.co/api/models/${repo}/tree/${info.sha}`);

const changes = [];
for (const model of manifest.models.filter((m) => !m.converted)) {
  const entry = tree.find((f) => f.path === model.file);
  if (!entry || !entry.lfs) {
    console.log(`${model.id}: ${model.file} is no longer in the source`);
    continue;
  }
  if (entry.lfs.oid !== model.sha256 || entry.size !== model.size) changes.push({ model, entry });
}

// For information: the newest official Real-ESRGAN release (new weights need converting to ONNX before they can be used here).
try {
  const rel = await json('https://api.github.com/repos/xinntao/Real-ESRGAN/releases/latest');
  console.log(`Real-ESRGAN's latest release: ${rel.tag_name} (${rel.published_at})`);
} catch (e) {
  console.log(`(could not read Real-ESRGAN's releases: ${e.message})`);
}

if (!changes.length) {
  console.log(`The models are up to date (source revision ${info.sha.slice(0, 8)}).`);
  process.exit(0);
}
for (const { model, entry } of changes) console.log(`${model.id}: changed at the source (${model.sha256.slice(0, 8)} -> ${entry.lfs.oid.slice(0, 8)}, ${entry.size} bytes)`);
if (mode === 'check') process.exit(1);

for (const { model, entry } of changes) {
  const res = await fetch(`https://huggingface.co/${repo}/resolve/${info.sha}/${model.file}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download ${model.file}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== entry.size || hash !== entry.lfs.oid) throw new Error(`${model.file} did not download correctly (${hash})`);
  fs.writeFileSync(path.join(root, 'models', model.file), bytes);
  model.size = bytes.length;
  model.sha256 = hash;
}
manifest.source.revision = info.sha;
manifest.source.checked = new Date().toISOString().slice(0, 10);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(dataPath, `// Generated by scripts/update-models.mjs from models/manifest.json: do not edit by hand.\nexport const MODEL_SOURCE = ${JSON.stringify(manifest.source, null, 2)};\nexport const MODEL_DATA = ${JSON.stringify(manifest.models, null, 2)};\n`);

// models/README.md lists the hashes too
const readmePath = path.join(root, 'models', 'README.md');
let readme = fs.readFileSync(readmePath, 'utf8');
for (const m of manifest.models) {
  readme = readme.replace(new RegExp(`(\\| \`${m.file.replace('.', '\\.')}\` \\| )[^|]*\\| \`[0-9a-f]{64}\``), `$1${(m.size / 1e6).toFixed(m.size < 1e7 ? 1 : 0)} MB | \`${m.sha256}\``);
}
fs.writeFileSync(readmePath, readme);
console.log(`Updated ${changes.length} model(s) to source revision ${info.sha.slice(0, 8)}.`);
