# Terminal replay UI

`player.html` contains Kimchi's replay page; `playback.js` owns its timing, seeking and terminal controls. The normal pinned `@xterm/xterm` dependency renders the recorded output, with `@xterm/addon-unicode11` matching part-checkpoint character widths. `scripts/copy-resources.js` stages those files from `node_modules` during setup/build, with no separate asset downloader.

Only authored code and documentation are tracked here. Generated files stay in the ignored `generated/` directory; binary builds stage them in `dist/share/kimchi/terminal-replay/`. Required package notices are preserved inside generated JavaScript. HTML exports embed the assets and play offline.

Run `pnpm install` or `pnpm run build` after a fresh checkout. Recheck offline playback, resize, Unicode, seeking and standalone downloads when changing the dependency pin or controller.
