# Camera

The light field controls. Each can be animated: the <img src="images/key-prev.png" width="8" height="14" alt="previous keyframe"> ◆ <img src="images/key-next.png" width="8" height="14" alt="next keyframe"> at the right of a setting adds or removes its keyframes and moves between them (see [[Animation]]).

## Depth

- *Aperture:* f/22 to f/0.5. Small apertures keep everything sharp; wide ones blur what is away from the focus (click the picture to choose what is in focus). Beyond f/2, the widest the camera can record, the blur is synthetic, using the depth map.
- *Depth:* how quickly things blur away from the focus.
- *Smoothing:* smooths the depth map, following the picture's edges.
- *Show depth map:* warm colors are near, cool colors are far.

How carefully the depth map is measured is set in [[Render]] (*High quality depth map*).

## Focus Spread

- *Focus Point:* where you last clicked; spread and tilt are centered there.
- *Spread:* a range of depth kept sharp on each side of the focus.
- *Smoothing:* softens the edges of that range, so blur builds up gradually.
- *Show spread:* tints what lies outside it, blue nearer and orange farther.

## Tilt

Tilts the plane of focus, like a tilt-shift lens: *Tilt* is the amount, *Rotation* the direction. *Enabled* turns the tilt off and on without losing the settings.

## Perspective

*Viewpoint* shows where the viewpoint is (drag on the picture to move it), as a share of the lens aperture across and down; *Center* is the middle.

Moving the viewpoint shifts every depth but one, the focus plane (or, with the aperture closed, the depth the camera focused on). *Custom pivot* and *Pivot depth* choose another depth to stay still.

## Bokeh

The shape of out-of-focus highlights: *Natural*, *Optical (softer)*, *Circle* or *Hexagon*, and *Highlights* to make bright points glow into bokeh balls.
