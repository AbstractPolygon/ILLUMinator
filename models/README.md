# Upscaling models

Copies of the optional super resolution models the app can download (Settings > Upscaling models). They are **not** part of the app's own download or installer: the app fetches a model when its checkbox is ticked, checks it against the SHA-256 below and keeps it on the computer.

| File | Size | SHA-256 |
| --- | --- | --- |
| `realesr-general-x4v3.onnx` | 4.9 MB | `f788518cc66e302bc9b6946016e989dd9374f1012d5b6c0c7e753904ef3f99e4` |
| `4xNomosUni_span_multijpg.onnx` | 1.7 MB | `49479befe6370d232fb47c8f03def666b692121862b8afcf93dddb64b125a747` |
| `RealESRGAN_x4plus.onnx` | 67 MB | `c6a0cc3b0535ea566f30f20b8dd42f0462502b9e22cf45ea6e0b3ccf55d03d98` |

The two Real-ESRGAN files are ONNX exports (opset 17, input `input` float32 `[1, 3, H, W]` 0..1, output `output` `[1, 3, 4H, 4W]`) of the official [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) weights by Xintao Wang et al., released under the BSD 3-Clause License (`LICENSE-Real-ESRGAN.txt`). The exports are by [relax123666/clearpic-models](https://huggingface.co/relax123666/clearpic-models), pinned in `manifest.json`.

**SPAN x4** (`4xNomosUni_span_multijpg.onnx`) is converted here: there is no ONNX of it at its source, [Phips/4xNomosUni_span_multijpg](https://huggingface.co/Phips/4xNomosUni_span_multijpg) (safetensors weights by Philip Hofmann, CC BY 4.0, of a SPAN network by Wan et al., Apache-2.0; `LICENSE-4xNomosUni_span_multijpg.txt`). `scripts/convert-span.py` makes the ONNX file from the weights with PyTorch and spandrel (the versions are in `manifest.json`); the converted file matches the PyTorch model to about 5e-6. If the weights change at the source the workflow opens an issue, because converting again is done by hand.

## Keeping them up to date

`manifest.json` is the source of truth. `node scripts/update-models.mjs --check` compares it with the source repository and the official Real-ESRGAN releases; `--update` downloads what changed, checks it and rewrites the files, `manifest.json` and `app/js/core/upscalemodels-data.js` together. The *Upscaling models* workflow (`.github/workflows/models.yml`) runs it every week and opens a pull request when something changed, so new weights are reviewed before they ship. The app tries this repository first and the pinned source second, and accepts only a file with the expected SHA-256, so an older app keeps working after a model is replaced.
