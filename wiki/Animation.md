# Animation

*Enabled* turns on playing, scrubbing and video export.

## Settings

- *Frame rate:* 23.976, 24, 25, 29.97, 30, 48, 50, 59.94 or 60 frames a second, or *Custom* (1 to 240). Playback, keyframes and exported video all use it.
- *Animate:*
  - *Viewpoint* moves the viewpoint along a *Path* (circle, left–right, up–down, figure eight, diagonal) by an *Amount*. *Amount* can be keyframed.
  - *Focus sweep* refocuses from *Near* to *Far* in a number of *Steps*. *Near* and *Far* can be keyframed; *Steps* sets the number of frames, so it cannot.
  - *Keyframes* follows keyframes you set in the keyframe editor (below). *Zoom*, *Pan X* and *Pan Y* frame the picture.

## Play bar

Below the picture:

<img src="images/stop.png" width="20" height="20" alt="Stop"> **Stop:** back to the start.

<img src="images/pause.png" width="20" height="20" alt="Pause"> **Pause**

<img src="images/play.png" width="20" height="20" alt="Play"> **Play**

<img src="images/loop.png" width="20" height="20" alt="Loop"> **Loop:** play over and over; off, playback stops at the end.

The readout shows the current frame and time of the whole, and *Length* sets the length in frames. Drag the slider to move through the animation at any time; before the frames are rendered, the picture shows the animation's settings there. Space plays and pauses, also right after using a slider or button (only fields you type in keep it).

## Keyframes in the sidebar

Every setting that can be animated has <img src="images/key-prev.png" width="8" height="14" alt="previous keyframe"> ◆ <img src="images/key-next.png" width="8" height="14" alt="next keyframe"> at its right in the sidebar, in a separate column (as in DaVinci Resolve's Inspector):

**◆** turns the setting's animation on or off. *Hollow:* not animated; clicking it adds a keyframe at the playhead, and turns on *Animate: Keyframes* if needed. *Filled:* animated; clicking it removes all of that setting's keyframes. *Blue:* a keyframe of the setting sits at the playhead.

<img src="images/key-prev.png" width="8" height="14" alt="previous keyframe"> <img src="images/key-next.png" width="8" height="14" alt="next keyframe"> move the playhead to the setting's previous and next keyframe. Each shows only when there is a keyframe that way.

They are on every slider of [[Process]] (the color matrix numbers aside), on every setting of the selected local adjustment (its strength, position, size, angle, fade, feather and every effect), on every Camera setting (the *Focus Point* row covers the focus and the focus point together, the *Viewpoint* row the viewpoint), on every slider of [[Optics]], and in the Animation panel on *Zoom*, *Pan X*, *Pan Y*, *Amount*, *Near* and *Far*. A slider without them keeps its full width.

## Keyframe editor

With *Enabled* on, the keyframe editor opens under the play bar. With *Animate: Keyframes* it holds every setting; with *Viewpoint* or *Focus sweep*, the settings of those (Amount; Near and Far), over the path or sweep's frames. Drag its top edge to make it taller or shorter; double-click the edge for the normal height. Zoom the time with **−**, **All** and **+**, or Ctrl / ⌘ + mouse wheel; scroll along it with Shift + wheel or the slider below the tracks.

**Tracks.** Every setting that can be animated has a track, grouped like the sidebar: a group for each panel, and in it a group for each section. Each opens and closes:

- *Process:* LUT, White Balance, Tone, Tone Curve and Color, each with its sliders. These start closed.
- *Local Adjustments:* one group for each adjustment, named after the filter that made it (or the mask): its strength, shape and every effect. These start closed.
- *Camera:*
  - *Depth:* aperture, depth of field and focus.
  - *Focus Spread:* focus point X and Y, spread and smoothing.
  - *Tilt:* tilt and rotation (shown, and used, only with Tilt *Enabled*).
  - *Perspective:* viewpoint and pivot depth (shown, and used, only with *Custom pivot* on; see [[Camera]]).
  - *Bokeh:* highlights.

  Depth and Perspective start open, the others closed. *Depth smoothing* and the bokeh *Shape* cannot be animated: smoothing reworks the whole depth map, and a shape is a choice, not a value.
- *Optics:* Chromatic Aberration, Lens Correction and Flare, each with its sliders. These start closed.
- *Animation:* *Framing* (zoom, pan X and pan Y) with keyframes; *Viewpoint path* (Amount) or *Focus sweep* (Near and Far) with those.

A slider's track shows only while the slider can be used (for example the white balance with *Auto* off, or the defringe sliders with Chromatic Aberration *Enabled*).

A group's summary row shows a diamond wherever the group has keyframes; dragging one moves every keyframe at that time.

**Adding keyframes.**
- The ◆ beside a track keys that setting at the playhead; the ◆ on a group heading keys the whole group.
- *Key all* keys every track of the open groups.
- *Auto key*: while on, changing a setting records a keyframe at the playhead, on that setting's track only.

**Showing tracks.** *Only keyed* shows only the settings that have keyframes, and the groups holding them, in both views. The app remembers the choice.

**Editing keyframes.**
- Click a keyframe to select it and see its value; drag it to move it in time.
- Drag on an empty part of a track to select keyframes in a box; Shift adds to the selection, and Shift-click adds or removes one. Selected keyframes are blue. Ctrl / ⌘ + A selects all.
- Dragging any selected keyframe moves all of them. *Delete key* (or Delete) deletes them.
- Drag on the time ruler, or grab the playhead (the blue line) on any row, to move it; the picture follows.

**Curves.** The curve menu in the editor's bar (*Auto*, *Linear*, …) sets how the selected keyframe eases to the next one:
- *Auto (continuous):* one smooth curve through all the keyframes, like Blender's auto handles. It flattens at highs, lows and the ends, and never overshoots.
- *Linear*, *Smooth*, *Ease in*, *Ease out*, *Hold*, or *Custom*, a curve you shape by dragging its two handles.

Every animation frame uses its keyframed settings (color, optics, focus spread, tilt and bokeh highlights included) in the preview, in exported videos and in full sensor renders.

**Curves view.** <img src="images/tl-curves.png" width="20" height="20" alt="Curves view"> at the left of the editor (beside <img src="images/tl-keyframes.png" width="20" height="20" alt="Keyframes view">, the keyframes view) shows each setting as a curve over time, like Blender's Graph Editor. Each curve is fitted to the height of the view. Drag a keyframe up or down to change its value, or sideways to change its time. The selected keyframe shows its handles on the curve: drag them to shape the curve, and the handle on the other side turns with them, so the curve stays smooth. Checkboxes in the list hide curves.
