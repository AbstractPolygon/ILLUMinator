# Upscaling models

Copies of the optional super resolution models the app can download (Settings > Upscaling models). They are **not** part of the app's own download or installer: the app fetches a model when its checkbox is ticked, checks it against the SHA-256 below and keeps it on the computer.

| File | Size | SHA-256 |
| --- | --- | --- |
| `realesr-general-x4v3.onnx` | 4.9 MB | `f788518cc66e302bc9b6946016e989dd9374f1012d5b6c0c7e753904ef3f99e4` |
| `RealESRGAN_x4plus.onnx` | 67 MB | `c6a0cc3b0535ea566f30f20b8dd42f0462502b9e22cf45ea6e0b3ccf55d03d98` |

They are ONNX exports (opset 17, input `input` float32 `[1, 3, H, W]` 0..1, output `output` `[1, 3, 4H, 4W]`) of the official [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) weights by Xintao Wang et al., released under the BSD 3-Clause License (`LICENSE-Real-ESRGAN.txt`). The exports are by [relax123666/clearpic-models](https://huggingface.co/relax123666/clearpic-models), pinned in `manifest.json`.

## Keeping them up to date

`manifest.json` is the source of truth. `node scripts/update-models.mjs --check` compares it with the source repository and the official Real-ESRGAN releases; `--update` downloads what changed, checks it and rewrites the files, `manifest.json` and `app/js/core/upscalemodels-data.js` together. The *Upscaling models* workflow (`.github/workflows/models.yml`) runs it every week and opens a pull request when something changed, so new weights are reviewed before they ship. The app tries this repository first and the pinned source second, and accepts only a file with the expected SHA-256, so an older app keeps working after a model is replaced.
