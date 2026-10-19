# Render

The *Render Settings* section of the sidebar (3D, Quality, Upscaling, Photo and Video) and the Render, Save and Export buttons below it. Render Settings shows in the Camera view, not the Lenslets view.

## 3D

A stereo pair from two viewpoints across the lens, for photos and videos.

- *Show 3D* shows the picture in 3D while you edit.
- *3D type:* *Anaglyph* (red / cyan glasses), *Side by side* (parallel viewing), *Cross-eyed* or *VR headset* (side by side at full size for headsets such as the Meta Quest 3; files get `_3D_SBS` in their names so headset players recognize them).
- *Baseline:* how far apart the two viewpoints are.
- *Save 3D image* saves the pair as an image, in the Photo *File format*. With *Show 3D* on, *Export video* makes a 3D video in the same 3D type.
- *View in VR* (in a headset's web browser, such as the Meta Quest Browser, with the browser version) shows the 3D picture on a large screen in front of you; press a controller trigger to leave.

## Quality

These apply to photos and videos alike.

- *Resolution:* the picture's resolution, 1× (fast), 1.5× or 2×, for editing, photos and every video frame.
- *Full sensor* (F): renders a high resolution still from every pixel of the sensor. *Scale* sets its size (2×, 3× or 4× the lens grid) and *Detail recovery* adds passes that bring back more fine detail (slower). *Render*, just below the Render Settings section, starts it. The still is shown at the Photo *Size*, enlarged with the Upscaling settings, just as it will be saved; *Save PNG* then saves it. The first full sensor render of a photo also measures where each microlens's center really sits, from that photo alone (each camera, zoom and focus is a little different), and every later render of the photo uses it for sharper close detail. With the aperture closed (everything in focus), pixels at the edge of a near object are checked against the depths on both sides of the edge, so edges stay clean instead of doubled. With *Full sensor* on, *Export video* renders every frame this way too (much slower). With *Auto render* (under the *Render* button) checked, the still is rendered again by itself shortly after each change, once you stop dragging.

## Upscaling

Settings for every enlarged picture, photo or video. *Method*: *Lanczos (sharp)*, a filter that keeps edges crisp; *Smooth*, the softer ordinary enlarging; or *FSR 1* (AMD FidelityFX Super Resolution 1), which enlarges along the edges it finds and then sharpens with its built-in contrast-adaptive sharpening. All three run on the graphics card, or on the processor where WebGL 2 is not available (slower). When a picture is made smaller, FSR 1 uses Lanczos.

- *Sharpen:* sharpens the enlarged picture to bring back crispness lost in enlarging; 0 for none (25 by default). With FSR 1 it sets the strength of FSR's built-in sharpening. It has no effect at *Native* size.

Enlarging adds pixels, not detail. For the most detail, render with *Full sensor* and enlarge that.

## Speed

Rendering runs on the GPU (WebGL 2); without it, on the CPU, much more slowly. On computers with two graphics chips (many laptops) ILLUMinator asks for the faster one. While you drag a slider or the picture, strong depth of field blur is drawn as a quicker draft; the finished picture follows when you let go. [[Histogram and Info]] shows the renderer in use and, where the browser can measure it, the GPU time per view.

## Photo

Photo and Video are the last two subsections of *Render Settings*. Below Render Settings, always shown: *Render*, *Auto render*, *Save PNG* and *Export video*.

- *Size:* how much saved photos and 3D images are enlarged: *Native* (as rendered), 1.5×, 2×, 3× or 4×, with the [Upscaling](#upscaling) settings. Each option shows the size in pixels it gives.
- *File format:* *PNG* (lossless, bigger files) or *JPEG* (much smaller files). For JPEG, *JPEG quality* (50 to 100, 92 by default) sets how much detail is kept.
- *Save PNG* (or *Save JPEG*), below the Render button, saves the picture as shown, at that size.

## Video

- *Size:* *1080p*, *1440p* or *4K (2160p)* keep the shape of the crop, with that many pixels on the short side. The *Social media* sizes have a fixed shape and take the largest centered part of the picture with it:
  - 9:16, 1080 × 1920: Instagram Reels, TikTok, YouTube Shorts, Stories (and 2160 × 3840 for 4K vertical)
  - 4:5, 1080 × 1350: Instagram and Facebook feed posts
  - 1:1, 1080 × 1080: square posts
  - 16:9, 1920 × 1080: YouTube, X, LinkedIn (and 3840 × 2160 for YouTube 4K)

  For a part of the picture other than the center, first crop to the same shape (Crop → *Aspect ratio*). Frames are enlarged with the [Upscaling](#upscaling) settings; frames larger than the video are reduced with a filter that keeps fine detail from flickering.
- *Compression:* the codec. WebM: *VP9*, *VP8* or *AV1*; MP4: *H.264*, *H.265 (HEVC)* or *AV1*. Only the kinds this browser or computer can record are offered; the others are marked *not available here*. H.265 depends on the computer's video hardware.
- *File format:* *WebM* (plays in browsers and most players) or *MP4* (plays nearly everywhere).
- *Quality:* the video's bitrate, 1 to 40 Mbit/s (16 by default). Higher keeps more detail and makes bigger files; for 4K, 30 or more works well.
- *Export video* saves the animation, at the current *Resolution*, or with *Full sensor* on, every frame rendered from the whole sensor with its *Scale* and *Detail recovery*. See [[Exporting]].
