# Self-hosted fonts

`src/app/layout.tsx` loads these files with `next/font/local`. The build does not download fonts, so a network failure cannot stop it.

| File                                      | Family                     | Version | Axes                             | Used by                              |
| ----------------------------------------- | -------------------------- | ------- | -------------------------------- | ------------------------------------ |
| `Geist-Variable.woff2`                    | Geist                      | 1.800   | wght 100–900                     | Slate: UI text                       |
| `GeistMono-Variable.woff2`                | Geist Mono                 | 1.701   | wght 100–900                     | Slate, Whiteboard, Triplicate: code  |
| `SchibstedGrotesk-Variable.woff2`         | Schibsted Grotesk          | 1.100   | wght 700–800 (range limited)     | Slate: titles (preloaded)            |
| `AtkinsonHyperlegibleNext-Variable.woff2` | Atkinson Hyperlegible Next | 2.001   | wght 200–800                     | Whiteboard: UI and titles            |
| `Archivo-Variable.woff2`                  | Archivo                    | 2.001   | wght 100–900, wdth 62–125        | Triplicate, Stockroom: UI and titles |
| `BigShouldersStencil-Variable.woff2`      | Big Shoulders Stencil      | 2.001   | wght 100–900 (opsz fixed at 14)  | Stockroom: page titles               |
| `MartianMono-Variable.woff2`              | Martian Mono               | 1.000   | wght 100–800 (wdth fixed at 100) | Stockroom: code                      |

All fonts use the SIL Open Font License 1.1. The license for each family is in `licenses/`.

## How the files are made

Each file has one variable font with every subset that Google Fonts serves for that family. The subsets are Latin, Latin Extended, and Vietnamese or Cyrillic where the family has them. One file per family keeps `next/font/local` simple: it has no per-file `unicode-range`.

To update a font:

1. Download `Family[axes].ttf` and `OFL.txt` from `ofl/<family>/` in the [google/fonts](https://github.com/google/fonts) repository.
2. Fix the axes that Google Fonts fixes: `opsz` at 14 for Big Shoulders Stencil and `wdth` at 100 for Martian Mono. These are not the `fvar` defaults (72 and 112.5). Limit Schibsted Grotesk to `wght` 700–800, the weights the design uses. Use `fontTools.varLib.instancer`.
3. Subset the font to the Unicode ranges in the `@font-face` rules that Google Fonts serves for the family, plus every character in those served files. Keep all layout features and variation tables, and remove hinting as Google Fonts does. Use `fontTools.subset` with `--flavor=woff2` and `--no-hinting`.
4. Compare the result with the files Google Fonts serves: the same tables, the same advance widths, and no missing characters.
5. Replace the file here and the license in `licenses/`. Update the version in the table.
6. Build the frontend and compare screenshots of all four looks at 1440 px and 390 px.

Caution: keep the `weight` range in `layout.tsx` equal to the font's `wght` axis. Without a range, the face counts as weight 400 only, and the browser synthesizes bold text instead of using the real bold.
