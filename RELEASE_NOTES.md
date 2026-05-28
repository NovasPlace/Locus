# Locus v4.2.4

This release prepares Locus for public Windows distribution through GitHub Releases and updates the public positioning around the current product direction.

## Highlights

- Locus is now described as a **local-first workspace context layer**.
- Windows release automation is configured through GitHub Actions.
- Windows builds now support both installer and portable executable targets.
- README now explains how users download the `.exe` from GitHub Releases.
- Changelog now includes the v4.2.4 release entry.

## What Locus is

Locus captures workspace context, lets users organize it before saving, and stores clean memory inside persistent threads.

Core flow:

```text
Capture context
  → stage it in Working Context
  → edit or organize it in Note / Document / Screenshot mode
  → save it to a Locus thread
  → search, review, reuse, or send it to a model later
```

## Download

Windows users should download the latest installer or portable build from:

https://github.com/NovasPlace/Locus/releases

Expected Windows assets:

- `Locus Setup.exe`
- `Locus portable.exe`

## Notes

The GitHub Actions workflow builds release artifacts when a version tag is pushed, for example:

```bash
git tag v4.2.4
git push origin v4.2.4
```

If a release exists without assets, the workflow may still be running or the release tag may need to be pushed again.
