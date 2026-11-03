import sys, torch, onnx, numpy as np
from spandrel import ModelLoader
src, dst = sys.argv[1], sys.argv[2]
desc = ModelLoader().load_from_file(src)
print('architecture', desc.architecture.name, 'scale', desc.scale, 'in', desc.input_channels, 'out', desc.output_channels, 'range', desc.input_range if hasattr(desc,'input_range') else None)
model = desc.model.eval()
x = torch.rand(1, 3, 64, 80)
with torch.no_grad():
    y = model(x)
print('torch output', tuple(y.shape), float(y.min()), float(y.max()))
torch.onnx.export(model, x, dst, input_names=['input'], output_names=['output'],
                  dynamic_axes={'input': {2: 'h', 3: 'w'}, 'output': {2: 'H', 3: 'W'}}, opset_version=17, dynamo=False)
onnx.checker.check_model(onnx.load(dst))
print('saved', dst)
