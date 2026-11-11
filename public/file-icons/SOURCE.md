# Material Icon Theme — selected file and folder icons

Source: https://github.com/material-extensions/vscode-material-icon-theme/tree/ced21b9b5241c1efa502a8c46ec7363a690a7058

MIT license; Copyright (c) 2025 Material Extensions. The complete upstream license is included in LICENSE.txt and is distributed next to the SVG sprite.

Piora vendors 57 selected upstream SVGs as a single local sprite, including the upstream light TOML variant. Each source hash and generated symbol is recorded in manifest.json. The complete VS Code extension and its icon catalog are not runtime dependencies.

Transformations: wrap SVGs as symbols; prefix local ids; generate expanded-folder paths with the upstream canonical path from src/scripts/svg/generateOpenFolderIcons.ts; derive a plain #90a4ae folder from folder-src without its motif. The existing app theme selects light/dark variants. File and folder associations are curated in components/FileIcons.tsx.

To regenerate from the pinned upstream: python scripts/sync-material-icons.py. This opt-in maintenance command downloads immutable source files; the application renders offline and never contacts upstream.
