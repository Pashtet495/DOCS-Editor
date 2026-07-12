# Third-Party Libraries and Licenses

This project uses the following third-party libraries. All library files are
bundled locally in this `libs/` folder to avoid runtime CDN dependencies.

## math.js (libs/mathjs/)
- **Version**: 12.4.2
- **License**: Apache License 2.0 (see `libs/mathjs/LICENSE`)
- **Usage**: Formula evaluation engine for the table editor and document formulas.
- **Source**: https://github.com/josdejong/mathjs

## KaTeX (libs/katex/)
- **Version**: 0.16.9
- **License**: MIT License (see `libs/katex/LICENSE`)
- **Usage**: LaTeX rendering for formula preview (document formula blocks and
  table editor formula preview bar).
- **Source**: https://github.com/KaTeX/KaTeX
- **Font files**: 20 woff2 font files in `libs/katex/fonts/` (SIL Open Font License)

## SuperDoc (libs/superdoc-licenses/)
- **Version**: 1.43.1 (installed via npm, not bundled here)
- **License**: Custom license (see `libs/superdoc-licenses/LICENSE`)
- **Usage**: WYSIWYG document editor engine (DOCX import/export, ProseMirror-based).
- **Source**: https://github.com/Harbour-Enterprises/superdoc
- **IMPORTANT**: SuperDoc has a custom license with restrictions. Users of this
  project's source code must review the license terms before using SuperDoc.
  The license file is included for reference.

## License Summary

| Library | License | Commercial Use |
|---------|---------|----------------|
| math.js | Apache 2.0 | Yes |
| KaTeX | MIT | Yes |
| KaTeX Fonts | SIL OFL 1.1 | Yes (with attribution) |
| SuperDoc | Custom | **Review required** |
