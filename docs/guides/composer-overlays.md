# Composer overlays

The composer background is transparent. Its border and focus ring identify the drafting surface.

Attached provider notices, mention suggestions, and the Add menu occupy space above the editor. Their content determines the reserved height. Closing them releases that space.

The slash-command popup remains floating. Opening it does not change the composer height.

`ComposerOverlayLayout` supplies the in-flow portal host. Attached surfaces outside that layout, including standalone preview contexts, retain fixed positioning.
