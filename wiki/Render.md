# Render

## 3D

A stereo pair from two viewpoints across the lens.

- *Show 3D* shows the picture in 3D while you edit.
- *3D type:* *Anaglyph* (red / cyan glasses), *Side by side* (parallel viewing) or *Cross-eyed*.
- *Baseline:* how far apart the two viewpoints are.
- *Save 3D image* saves the pair as a PNG.

## Quality

- *Resolution:* the picture's resolution while editing, 1× (fast), 1.5× or 2×.
- *High quality depth map:* sharper depth edges that match the photo, about twice as slow to measure. Off, the faster depth map is used.
- *Full resolution* (F): renders a high resolution still from every pixel of the sensor. *Scale* sets its size (2×, 3× or 4× the lens grid) and *Detail recovery* adds passes that bring back more fine detail (slower). *Render* starts it.

## Speed

Rendering runs on the GPU (WebGL 2); without it, on the CPU, much more slowly. On computers with two graphics chips (many laptops) ILLUMinator asks for the faster one. While you drag a slider or the picture, strong depth of field blur is drawn as a quicker draft; the finished picture follows when you let go. [[Histogram and Info]] shows the renderer in use and, where the browser can measure it, the GPU time per view.

## Photo

- *Size:* how much saved photos and 3D images are enlarged: *Native* (as rendered), 1.5×, 2×, 3× or 4×.
- *Upscaling:* how they are enlarged: *Lanczos (sharp)*, which keeps edges crisp, or *Smooth*, softer. Used when *Size* is larger than *Native*; the *Sharpen* setting under *Upscaling* applies too.
- *Save PNG* saves the picture as shown, at that size.

## Video

- *File format:* *WebM* (plays in browsers and most players) or *MP4* (plays nearly everywhere).
- *Size:* *1080p*, *1440p* or *4K (2160p)* keep the shape of the crop, with that many pixels on the short side. The *Social media* sizes have a fixed shape and take the largest centered part of the picture with it:
  - 9:16, 1080 × 1920: Instagram Reels, TikTok, YouTube Shorts, Stories (and 2160 × 3840 for 4K vertical)
  - 4:5, 1080 × 1350: Instagram and Facebook feed posts
  - 1:1, 1080 × 1080: square posts
  - 16:9, 1920 × 1080: YouTube, X, LinkedIn (and 3840 × 2160 for YouTube 4K)

  For a part of the picture other than the center, first crop to the same shape (Crop → *Aspect ratio*).
- *Upscaling:* how each frame is brought to that size: *Lanczos (sharp)* or *Smooth*. Frames larger than the video are reduced with a filter that keeps fine detail from flickering.
- *Compression:* the codec. WebM: *VP9*, *VP8* or *AV1*; MP4: *H.264*, *H.265 (HEVC)* or *AV1*. Only the kinds this browser or computer can record are offered; the others are marked *not available here*. H.265 depends on the computer's video hardware.
- *Quality:* the video's bitrate, 1 to 40 Mbit/s (16 by default). Higher keeps more detail and makes bigger files; for 4K, 30 or more works well.
- *Export video* saves the animation, at the current *Resolution*, or with *Full resolution* on, every frame rendered from the whole sensor with its *Scale* and *Detail recovery*. See [[Exporting]].

## Upscaling

Settings for every enlarged picture, photo or video. The method is chosen under *Photo* and *Video*: *Lanczos (sharp)*, a filter that keeps edges crisp, or *Smooth*, the softer ordinary enlarging.

- *Sharpen:* sharpens the enlarged picture to bring back crispness lost in enlarging; 0 for none (25 by default). It has no effect at *Native* size.

Enlarging adds pixels, not detail. For the most detail, render with *Full resolution* and enlarge that.
