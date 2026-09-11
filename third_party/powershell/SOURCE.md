# Bundled PowerShell

Windows x64 distributions include Microsoft's complete, self-contained
PowerShell ZIP (including .NET), pinned by `manifest.json`. Source and published
SHA-256: https://github.com/PowerShell/PowerShell/releases/tag/v7.6.6

`scripts/stage-powershell.mjs` downloads and verifies the archive during the
GitHub Actions packaging hook. All upstream files, including `LICENSE.txt`,
`ThirdPartyNotices.txt`, and module-specific notices, are preserved under
`resources/powershell/`. No runtime download or separate PowerShell installation
is required. Piora adds only `bootstrap.cjs` and `piora-manifest.json`.

The bootstrap adds the bundled directory to the application process's PATH
without changing the user's system PATH. Both the terminal and the coding
agent's PowerShell tool can use the bundled executable. PowerShell updates are
delivered with Piora updates; the standalone PowerShell update check is disabled.
