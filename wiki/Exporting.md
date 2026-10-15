# Exporting

From the **Render Settings** section and the buttons below it:

- **Quick export:** the export icon in the bar above the picture, next to Camera and Lenslets, opens a popup. Choose *Photo* or *Video* at the top; the popup then lists only that kind's settings, one per row: its Photo or Video settings, Quality, Upscaling and 3D. *Save* (or *Export video*) is at the bottom right, *Close* at the bottom left. They are the same settings as under Render Settings: a change in either place shows in the other.

- **Save PNG / Save JPEG** (Photo): the picture as shown, as a PNG or a JPEG (Photo *File format*, with *JPEG quality*), with all edits, crop, rotation and LUT, enlarged by the Photo *Size* (Native saves it as rendered).
- **Full sensor:** turn it on (or press F), choose a *Scale* and *Detail recovery*, then *Render*. The still uses every pixel the sensor recorded, several times the resolution of the live picture. *Save PNG* (or *Save JPEG*) then saves the full sensor still.
- **Show 3D:** shows the picture in 3D while you edit, in the chosen *3D type*; turn it off for the normal view.
- **Save 3D image:** a stereo pair from two viewpoints across the lens, enlarged by the Photo *Size*: *Anaglyph* (for red / cyan glasses), *Side by side*, *Cross-eyed* or *VR headset* (side by side at full size, with `_3D_SBS` in the file name so headset players such as those on the Meta Quest recognize it; set the player to 3D side by side if it does not). *Baseline* sets how far apart the two eyes are; more gives a stronger 3D effect.
- **View in VR:** in a VR headset's web browser (such as the Meta Quest Browser, using the browser version), *View in VR* under 3D shows the 3D picture on a large screen in front of you, each eye seeing a separate view. Press a controller trigger to leave.
- **Export video:** the animation (Animation panel, *Enabled*) as a video (in 3D when *Show 3D* is on: the chosen *3D type* and *Baseline*, both eyes for every frame) in the chosen *File format* (WebM or MP4), *Compression* (VP9, VP8, AV1, H.264 or H.265) and *Quality*, at the Video *Size* (1080p, 1440p or 4K, keeping the crop's shape, or a social media size such as 9:16 for Reels, TikTok and Shorts) and at the animation's *Frame rate*. The picture follows *Resolution*; with *Full sensor* on, every frame is rendered from the whole sensor with its *Scale* and *Detail recovery* first (much slower: each frame takes as long as a full sensor still).
- **Upscaling:** photos, 3D images and video frames are enlarged with the *Upscaling* settings under Render Settings: the *Method* (Lanczos, sharp; Smooth; or FSR 1) and *Sharpen*. Enlarging adds pixels, not detail. See [[Render]].
- **Export album:** in the library, **•••** next to an album → *Export album…* saves the album's original photos and edits as one `.zip`, to open in another library. See [[Library and Albums]].

In the desktop app files are saved where you choose; in a browser they go to your downloads.
