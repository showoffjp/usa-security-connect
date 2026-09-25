# Placeholder training footage

Two short, openly licensed clips standing in for real training video, so the
player, the progress tracking and the completion rules can be exercised
against actual video rather than a timer.

| File | Source | Licence |
|------|--------|---------|
| `bbb-10s.mp4` | *Big Buck Bunny*, Blender Foundation, via test-videos.co.uk | CC BY 3.0 |
| `flower.mp4` | MDN shared assets | CC0 |

They are served from this directory rather than a third-party CDN on purpose:
the first version of this pointed at Google's public sample bucket, which
started returning 403 and left every course showing "video unavailable".

To use your own footage, drop the files in here and set `video_url` on the
course to `/training/<file>.mp4` — nothing else has to change. `duration_seconds`
should match the real running time, since that is what the completion rule
measures against.
