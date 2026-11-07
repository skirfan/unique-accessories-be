# Invoice PDF fonts

Noto Sans Regular and Noto Sans Devanagari Regular are bundled from the official
[Noto fonts project](https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf).
`OFL.txt` contains their SIL Open Font License. Keep the license with distributed assets.
The backend resolves fonts relative to its source/compiled library, so deployments must retain
this `assets/fonts` directory beside `dist`. No runtime font downloads are required.
