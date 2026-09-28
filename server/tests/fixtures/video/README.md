Synthetic one-second, silent, solid-colour videos for upload tests (no personal data).
Generated with FFmpeg; the tests do not require FFmpeg:

```sh
ffmpeg -f lavfi -i color=c=steelblue:s=160x120:r=5 -t 1 -c:v libx264 -pix_fmt yuv420p -movflags +faststart sample.mp4
ffmpeg -i sample.mp4 -c copy sample.mov
ffmpeg -i sample.mp4 -c:v libvpx-vp9 sample.webm
```

The boundary test appends a valid MP4 `free` box to reach 104,857,600 bytes on disk,
uploads over real HTTP, attaches the upload to a message, and checks the downloaded
SHA-256. It uses the test blob store and a separate PostgreSQL test database, not
production nginx or object storage.
