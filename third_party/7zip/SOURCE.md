# Portable archive extractor

Piora distributes the unmodified x64 `7za.exe` from Igor Pavlov's official
[7-Zip Extra 26.04 release](https://github.com/ip7z/7zip/releases/tag/26.04).
The fixed download, executable, license and source SHA-256 values are recorded in
[manifest.json](manifest.json). No system-installed extractor is used at runtime.

`7za.exe` is licensed under LGPL-2.1-or-later, with BSD-2-Clause and BSD-3-Clause
components. The Extra package does not include the RAR decoder, so the unRAR
restriction from the full 7-Zip distribution does not apply to this executable.
The upstream `License.txt` contains the full BSD notices and copyright attribution.
The complete LGPL text is preserved as `COPYING`.

The corresponding, unmodified `7z2604-src.tar.xz` source archive is shipped beside
the executable in `resources/portable-extractor`, together with these notices and
the pin manifest. This provides source with every distributed installer/portable
artifact. See the source archive's build instructions to build a replacement;
Piora launches the separate executable and does not link its code into Piora.

`scripts/stage-portable-extractor.mjs` verifies every upstream download and copied
file. Build hooks and the packaged-runtime gate reject missing or altered files,
including the source archive and notices. The bootstrap extractor is only used on
the hash-verified official archive during CI staging; it is not shipped by Piora.
