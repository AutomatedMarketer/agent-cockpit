# Logo rules

Which tools get a real logo on the board, and why the rest get our own letter tile.

- **Default:** our own letter tile. A soft wash of the tool's colour and the first letter of its name.
  A colour is not a logo.
- **Real mark:** only where the brand's own rules let a site show that it uses the product, and the
  board's owner approved it. Today that is **GitHub** and **Vercel** (Nuno, 2026-10-10).
- **Drawings:** Simple Icons **16.32.0** (CC0-1.0), npm integrity
  `sha512-BwqATHxAulx7X6kNdTkecy7PBjLkgtAHcgrwYLd9iA+cD2At9DzhJwdwaSELk2+aZe01IfiM/Wxtyp68Dvup2A==`.
  The drawing is unchanged; only attributes were stripped, so each file is `svg`, `title` and `path`.
- **CC0 covers the drawing, never the trademark.** Simple Icons' own disclaimer says so.

## Files shipped

| File | Source | SHA-256 of the Simple Icons file | SHA-256 of the shipped file |
|---|---|---|---|
| `public/logos/github.svg` | `simple-icons@16.32.0/icons/github.svg` | `3bf8cceead820aec50d4ee825a3fd02c5a1cd6665cc9cf4cbf3d9c8861a204bb` | `806589d9764d0345d5a001f89009fcfe1cec5a97be796fdc8618ad296c22169b` |
| `public/logos/vercel.svg` | `simple-icons@16.32.0/icons/vercel.svg` | `57f1e4135486c566e9878fddd259f7f6bf8ec43f31e7e6e38a36d9e814a1c0e0` | `50d1ff4e4d69a32aef69d1795058caea3b22ae953811ffc84b2224d1e30130d9` |

Both are drawn in one plain colour (`--mark-mono`: white on dark, black on light), never recoloured.

## Rules, brand by brand

Read 2026-10-10. The planning agent read every row; the Vercel row was read again by the builder the
same day, and its attribution sentence below is copied word for word from that page.

| Brand | What its rules say | Page | Tile on the board |
|---|---|---|---|
| **GitHub** | Showing an integration is allowed with a permitted GitHub logo, unmodified in colour and shape | brand.github.com | **Real mark**, plain black or white |
| **Vercel** | Truthfully saying you use Vercel is allowed; do not modify the marks; include the attribution sentence. Its misuse list also says "do not use Vercel marks for commercial purposes", so get a read on that before the student template ships | vercel.com/geist/brands | **Real mark**, plain black or white, attribution in the README and under the Connections wall |
| **Anthropic** (Claude, Claude Code) | Only uses Anthropic approves beforehand; no colour changes | anthropic.com/legal/trademark-guidelines | Letter tile. A real mark only if Anthropic says yes |
| **Google** (Gmail, Calendar, Drive, Docs, Sheets) | Product icons need approval through Google's form | Google partner marketing hub | Letter tile |
| **Node.js** | The official logo only, no colour variations | OpenJS Foundation trademark policy | Letter tile |
| **Obsidian** | Commercial use: ask first | obsidian.md/brand | Letter tile |
| **Git** | The logo is CC BY 3.0 (Jason Long); the trademark policy was not checked | git-scm.com/downloads/logos | Letter tile |
| **OpenAI, ChatGPT, Slack** | Not in Simple Icons since 16.0.0 | Simple Icons 16.x data | Letter tile |
| **Hermes** (Hermes Agent) | Simple Icons' "Hermes" is an unrelated company | Simple Icons 16.32.0 data | Our own tile, in the board's link colour |
| **Everything else** | Not checked | | Letter tile until a row here says otherwise |

## Attribution sentences

> Product names and logos belong to their owners. They appear only to name the tools your own computer
> reports, and no endorsement is implied. Logo drawings from Simple Icons (CC0). Vercel, the Vercel
> design, Next.js and related marks, designs and logos are trademarks or registered trademarks of
> Vercel, Inc. or its affiliates in the US and other countries.

## Adding your own

A student may put their own logo files in `public/logos/` and add them to `BRANDS` in `public/app.js`
for their own board: their call, their use. The template itself never ships a mark that is not in the
table above as a real mark. `tests/logos.test.mjs` holds the shipped set to exactly that.
