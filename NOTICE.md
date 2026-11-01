# Notice

Nuvio Web is a modified version of [NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart) by Nuvio
Media, licensed under the GNU General Public License v3.0. See [LICENSE](./LICENSE).

**Changes (from November 2026):** adds a browser and PWA interface in `web/`, a streaming backend in
`server/`, build scripts `scripts/web-build.mjs` and `scripts/web-dev.mjs`, tests and documentation.
Upstream's application logic in `js/` is used unchanged.

Nuvio Web is an independent port and isn't affiliated with or endorsed by Nuvio Media. "Nuvio" and its
logos belong to their owners.

## Third-party components

- WebTorrent (MIT), used by `server/`
- hls.js (Apache-2.0)
- FFmpeg, invoked as a separate program by `server/` and not distributed with this source. Its license
  depends on the build you install.
- Material Symbols and Inter, loaded from Google Fonts (Apache-2.0 and OFL)
