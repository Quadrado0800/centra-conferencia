# Release updater

This directory contains a one-shot updater bundled with the Windows installer.
It is not a service and does not stay running. When an installation is
requested, it launches a temporary copy of itself and the temporary copy
downloads only assets from a published GitHub Release.

The first milestone is intentionally opt-in:

```powershell
.\.venv\Scripts\python.exe updater\updater.py --check
.\.venv\Scripts\python.exe updater\updater.py --download "$env:TEMP\CentralRecepcionista_Setup.exe"
```

The temporary copy prevents Windows from locking the updater while the new
installer replaces the installed files. The updater requires the GitHub-provided
SHA-256 digest before accepting an installer.

## Publishing a release

Push a tag matching the extension version, for example:

```powershell
git tag v2.1.7
git push origin v2.1.7
```

The workflow in `.github/workflows/release.yml` builds the Windows installer,
checks that the tag matches `manifest.json`, and publishes
`CentralRecepcionista_Setup.exe` to the GitHub Release. GitHub exposes the
asset SHA-256 digest through its API; the updater refuses an asset without it
or with a mismatched digest.
