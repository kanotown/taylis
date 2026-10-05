# Third-party notices

Taylis itself is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). This file lists third-party material
that is **bundled in this repository** (copied or derived data), with the license texts those sources require.

Libraries that the package managers download at build time (Python packages via `uv`, npm packages, Rust crates,
Swift packages, Gradle dependencies) and the container images used by `infra/` are not vendored here. Each is
distributed under its own license; the exact versions are recorded in `server/uv.lock`,
`apps/desktop/package-lock.json`, `apps/desktop/src-tauri/Cargo.lock`, `apps/android/gradle/libs.versions.toml`,
`apps/ios/project.yml` and `infra/docker-compose*.yml`.

Two third-party fonts are bundled: Noto Sans JP into the desktop / web build, and JetBrains Mono (for code) into the
desktop / web build and the Android app (both below; the npm packages' files ship inside the app and the web image).
No other third-party fonts, images or sounds are bundled: iOS uses the system fonts, Android the system's except for
code, and all clients the platform's emoji fonts and notification sounds.

## Emoji data

Files:

- `apps/shared/emoji.json` (built by `apps/shared/gen_emoji.py --update`)
- the tables generated from it: `apps/desktop/src/ui/emojiData.ts`, `apps/ios/ChikuwaChat/UI/EmojiData.swift`,
  `apps/android/app/src/main/java/jp/chikuwachat/android/ui/EmojiData.kt`
- `server/app/modules/importer/emoji_names.json` (the shortcode → glyph table the Mattermost / Slack importers use;
  shortcodes of the same public Slack-style / CLDR naming scheme)

Sources (the pinned versions are in `apps/shared/gen_emoji.py`):

| Source | What is used | License |
| --- | --- | --- |
| Unicode `emoji-test.txt`, Unicode Emoji 17.0 (<https://unicode.org/Public/17.0.0/emoji/>) | the emoji sequences, their order and groups | Unicode License v3 |
| Unicode CLDR annotations (`unicode-org/cldr-json` 48.2.3, English and Japanese, including the derived annotations) | names and search keywords | Unicode License v3 |
| `iamcal/emoji-data` v16.0.0 (<https://github.com/iamcal/emoji-data>) | Slack-style shortcodes | MIT |

### Unicode License v3 (Unicode emoji data, CLDR)

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.

SPDX-License-Identifier: Unicode-3.0
```

### MIT License (iamcal/emoji-data)

```text
The MIT License (MIT)

Copyright (c) 2013 Cal Henderson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Noto Sans JP (desktop / web font)

Files: the `@fontsource-variable/noto-sans-jp` npm package (version in `apps/desktop/package-lock.json`), imported by
`apps/desktop/src/main.tsx`; Vite copies its woff2 files (the variable weight axis, split by unicode-range) into the
build's `assets/`, so they are inside the desktop app and the web image.

Source: Noto Sans JP (<https://fonts.google.com/noto/specimen/Noto+Sans+JP>, <https://github.com/notofonts/noto-cjk>),
packaged by Fontsource (<https://fontsource.org>). License: SIL Open Font License 1.1. The font is used unmodified.

```text
Google Inc.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## JetBrains Mono (code font: desktop / web and Android)

Files:

- desktop / web: the `@fontsource-variable/jetbrains-mono` npm package (version in `apps/desktop/package-lock.json`),
  imported by `apps/desktop/src/main.tsx` (`wght.css`, the upright variable weight axis); Vite copies its woff2 files
  (split by unicode-range) into the build's `assets/`, so they are inside the desktop app and the web image. Used
  unmodified.
- Android: `apps/android/app/src/main/res/font/jetbrains_mono_regular.ttf` and `jetbrains_mono_bold.ttf`, derived
  from that package's `jetbrains-mono-latin-wght-normal.woff2` (version 5.3.0) with fontTools: instanced at weight 400
  and 700 and the layout features `calt` / `liga` (the programming ligatures) left out. The font has no Reserved Font
  Name, so the derived files keep the name JetBrains Mono.

Source: JetBrains Mono (<https://www.jetbrains.com/lp/mono/>, <https://github.com/JetBrains/JetBrainsMono>), packaged
by Fontsource (<https://fontsource.org>). License: SIL Open Font License 1.1.

```text
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## PDF.js (desktop / web document viewer)

Files: the `pdfjs-dist` npm package (version in `apps/desktop/package-lock.json`), its legacy build imported by
`apps/desktop/src/ui/pdfLoader.ts`; Vite emits `pdf.mjs` and the worker `pdf.worker.min.mjs` as chunks of the build
(loaded only when a document preview is opened), so they are inside the desktop app and the web image. The CMaps,
standard fonts and wasm decoders of the package are not bundled.

Source: PDF.js (<https://github.com/mozilla/pdf.js>), Mozilla Foundation. License: Apache License 2.0 (the same text as
[LICENSE](LICENSE)). Used unmodified.

## Document preview components that are not bundled (M108, docs/PREVIEWS.md)

Listed for reference; nothing of these is copied into this repository.

| Component | Where it runs | License |
| --- | --- | --- |
| pypdfium2 (<https://github.com/pypdfium2-team/pypdfium2>) and the PDFium binary its wheel carries | the server image, installed by `uv` (`server/uv.lock`); renders the first page of a PDF in a child process | pypdfium2: Apache-2.0 or BSD-3-Clause; PDFium: BSD-3-Clause / Apache-2.0; the wheel ships the licenses of PDFium's own dependencies (FreeType, ICU, Little CMS, libjpeg-turbo, OpenJPEG, zlib, ...) in its `dist-info/licenses` |
| Gotenberg (<https://github.com/gotenberg/gotenberg>), image `gotenberg/gotenberg:8.37.0-libreoffice` | the separate `converter` container (`infra/docker-compose.yml`), pulled from Docker Hub; the app talks to it over HTTP only | MIT |
| LibreOffice, inside the Gotenberg image | the same container; converts Office files to PDF | MPL-2.0 (with parts under other free licenses, as listed in the image) |

PyMuPDF was not used because it is AGPL-licensed.

## Brand assets

The Taylis name, icon and logo are not third-party material, but they are not under the Apache License either; see
[NOTICE](NOTICE) and [TRADEMARKS.md](TRADEMARKS.md).
