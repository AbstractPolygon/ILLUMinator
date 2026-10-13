# Animation

*Enabled* turns on playing, scrubbing and video export.

## Settings

- *Frame rate:* 23.976, 24, 25, 29.97, 30, 48, 50, 59.94 or 60 frames a second, or *Custom* (1 to 240). Playback, keyframes and exported video all use it.
- *Animate:*
  - *Viewpoint* moves the viewpoint along a *Path* (circle, left–right, up–down, figure eight, diagonal) by an *Amount*.
  - *Focus sweep* refocuses from *Near* to *Far* in a number of *Steps*.
  - *Keyframes* follows keyframes you set in the keyframe editor (below). *Zoom*, *Pan X* and *Pan Y* frame the picture.

## Play bar

Below the picture: **Stop** (back to the start), **Pause**, **Play** and **Loop** (play over and over; off, playback stops at the end). The readout shows the current frame and time of the whole, and *Length* sets the length in frames. Space plays and pauses.

## Keyframe editor

With *Animate: Keyframes*, the keyframe editor opens under the play bar. Drag its top edge to make it taller or shorter; double-click the edge for the normal height. Zoom the time with **−**, **All** and **+**, or Ctrl / ⌘ + mouse wheel; scroll along it with Shift + wheel or the slider below the tracks.

**Tracks.** Every setting that can be animated has a track, in groups that open and close:

- *Camera*, with a group for each section of the Camera panel:
  - *Depth:* aperture, depth of field and focus.
  - *Focus Spread:* focus point X and Y, spread and smoothing.
  - *Tilt:* tilt and rotation (shown, and used, only with Tilt *Enabled*).
  - *Perspective:* viewpoint and pivot depth (shown, and used, only with *Custom pivot* on; see [[Camera]]).
  - *Bokeh:* highlights.
  - *Framing:* zoom, pan X and pan Y.

  Depth, Perspective and Framing start open, the others closed.
- One group for each local adjustment, named after the living filter that made it (or the mask): its strength, shape and every effect. These groups start closed.

A group's summary row shows a diamond wherever the group has keyframes; dragging one moves every keyframe at that time.

**Adding keyframes.**
- With a photo open, the ◆ at the right of a setting in the sidebar turns its animation on or off. Hollow: clicking it adds a keyframe at the playhead (and turns on *Animate: Keyframes* if needed). Filled: the setting is animated, and clicking it removes all of its keyframes. It turns blue when a keyframe sits at the playhead. While a setting is animated, the arrows either side of its ◆ move the playhead to its previous and next keyframe.
- The ◆ beside a track keys that setting at the playhead; the ◆ on a group heading keys the whole group.
- *Key all* keys every track of the open groups.
- *Auto key*: while on, changing a setting records a keyframe at the playhead, on that setting's track only.
- *Only keyed*: shows only the settings that have keyframes, and the groups holding them.

**Editing keyframes.**
- Click a keyframe to select it and see its value; drag it to move it in time.
- Drag on an empty part of a track to select keyframes in a box; Shift adds to the selection, and Shift-click adds or removes one. Selected keyframes are blue. Ctrl / ⌘ + A selects all.
- Dragging any selected keyframe moves all of them. *Delete key* (or Delete) deletes them.
- Drag on the time ruler to move the playhead; the picture follows.

**Curves.** The curve menu in the editor's bar (*Auto*, *Linear*, …) sets how the selected keyframe eases to the next one:
- *Auto (continuous):* one smooth curve through all the keyframes, like Blender's auto handles. It flattens at highs, lows and the ends, and never overshoots.
- *Linear*, *Smooth*, *Ease in*, *Ease out*, *Hold*, or *Custom*, a curve you shape by dragging its two handles.

**Curves view.** The second button at the left of the editor shows each setting as a curve over time, like Blender's Graph Editor. Each curve is fitted to the height of the view. Drag a keyframe up or down to change its value, or sideways to change its time. The selected keyframe shows its handles on the curve: drag them to shape the curve, and the handle on the other side turns with them, so the curve stays smooth. Checkboxes in the list hide curves.
