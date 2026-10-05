# Third-party notices

Taylis itself is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). This file lists third-party material
that is **bundled in this repository** (copied or derived data), with the license texts those sources require.

Libraries that the package managers download at build time (Python packages via `uv`, npm packages, Rust crates,
Swift packages, Gradle dependencies) and the container images used by `infra/` are not vendored here. Each is
distributed under its own license; the exact versions are recorded in `server/uv.lock`,
`apps/desktop/package-lock.json`, `apps/desktop/src-tauri/Cargo.lock`, `apps/android/gradle/libs.versions.toml`,
`apps/ios/project.yml` and `infra/docker-compose*.yml`.

No third-party fonts, images or sounds are bundled: the clients use the platform's system fonts, emoji fonts and
notification sounds.

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

## Brand assets

The Taylis name, icon and logo are not third-party material, but they are not under the Apache License either; see
[NOTICE](NOTICE) and [TRADEMARKS.md](TRADEMARKS.md).
