# Fonts

These are the typefaces Arc offers in Easels that are **openly licensed**. They were
taken from `Arc.app/Contents/Resources/ARCClients_FontsManager.bundle`, and every one of
them is under the SIL Open Font License 1.1, which permits redistribution.

| Family | Files | Licence | Designer |
|---|---|---|---|
| Inter | Regular, Bold | OFL 1.1 | Rasmus Andersson |
| Nunito | Regular, Bold, Italic | OFL 1.1 | Vernon Adams, Cyreal, Jacques Le Bailly |
| EB Garamond | Variable, Variable Italic | OFL 1.1 | Georg Duffner, Octavio Pardo |
| Inconsolata | Regular, Bold | OFL 1.1 | Raph Levien |
| Space Mono | Regular, Bold, Italic | OFL 1.1 | Colophon Foundry |

## Deliberately not included

Arc's font bundle also ships **ABC Favorit**, **ABC Favorit Lining**, **ABC Favorit
Mono**, **ABC Oracle** (ABC Dinamo), **GT Ultra** (Grilli Type), **Marlin** /
**Marlin Soft**, **Pitch** / **Pitch Sans**, **Söhne** / **Söhne Breit** and
**National 2** (Klim Type Foundry), plus Apple's **New York**.

All of those are commercially licensed and cannot be redistributed. Two of them —
`National2Test` and `SoehneTest` — are *trial* cuts, which are licensed for evaluation
only and were arguably never meant to ship inside Arc at all.

If you own a licence for any of these, drop the files in this folder and add a matching
`@font-face` block plus a `FONTS` entry in `modules/objects.uc.js`.
