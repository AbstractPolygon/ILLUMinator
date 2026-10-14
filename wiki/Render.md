# Render

## Quality

- *High quality depth map:* sharper depth edges that match the photo, about twice as slow to measure. Off, the faster depth map is used.
- *Resolution:* the picture's resolution while editing, 1× (fast), 1.5× or 2×.
- *Full resolution* (F): renders a high resolution still from every pixel of the sensor. *Scale* sets its size (2×, 3× or 4× the lens grid) and *Detail recovery* adds passes that bring back more fine detail (slower). *Render* starts it.

## Speed

Rendering runs on the GPU (WebGL 2); without it, on the CPU, much more slowly. On computers with two graphics chips (many laptops) ILLUMinator asks for the faster one. While you drag a slider or the picture, strong depth of field blur is drawn as a quicker draft; the finished picture follows when you let go. [[Histogram and Info]] shows the renderer in use and, where the browser can measure it, the GPU time per view.

## 3D

A stereo pair from two viewpoints across the lens.

- *Show 3D* shows the picture in 3D while you edit.
- *3D type:* *Anaglyph* (red / cyan glasses), *Side by side* (parallel viewing) or *Cross-eyed*.
- *Baseline:* how far apart the two viewpoints are.
- *Save 3D image* saves the pair as a PNG.

## Photo

- *Size:* how much saved photos and 3D images are enlarged: *Native* (as rendered), 1.5×, 2×, 3× or 4×, with the *Upscaling* settings.
- *Save PNG* saves the picture as shown, at that size.

## Video

- *File format:* *WebM* (plays in browsers and most players) or *MP4* (plays nearly everywhere).
- *Compression:* the codec. WebM: *VP9*, *VP8* or *AV1*; MP4: *H.264*, *H.265 (HEVC)* or *AV1*. Only the kinds this browser or computer can record are offered; the others are marked *not available here*. H.265 depends on the computer's video hardware.
- *Quality:* *Low* (4 Mbit/s), *Medium* (8), *High* (16, the default) or *Maximum* (40), at 1080p; larger sizes get proportionally more. Higher quality keeps more detail and makes bigger files.
- *Size:* the height of exported videos (their short side): 1080p (the default), 1440p or 4K (2160p). Each frame is enlarged to it with the *Upscaling* settings.
- *Export video* saves the animation, at the current *Resolution*, or with *Full resolution* on, every frame rendered from the whole sensor with its *Scale* and *Detail recovery*. See [[Exporting]].

## Upscaling

How saved photos, 3D images and video frames are enlarged.

- *Method:* *Lanczos (sharp)*, a filter that keeps edges crisp, or *Smooth*, the softer ordinary enlarging.
- *Sharpen:* sharpens the enlarged picture to bring back crispness lost in enlarging; 0 for none (25 by default). It has no effect at *Native* size.

Enlarging adds pixels, not detail. For the most detail, render with *Full resolution* and enlarge that.
