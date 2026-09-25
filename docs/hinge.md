# Hinge

Measured on Phone Farm #1 (iPhone 13, 390×844 pt, scale 3) on 2026-09-13.
Coordinates live in `src/hinge/coordinates.ts`; screen detection in
`src/hinge/screen.ts`. Bundle id `co.hinge.mobile.ios`.

## Screens

| Screen | How we recognise it (OCR) | Notes |
|---|---|---|
| Discover, top of card | filter chips `Signals` / `Age` / `Height` at y≈80, name left-aligned at (45,137) | tab bar visible, floating undo (48,640) and X (48,703) |
| Discover, scrolled | name centred in sticky header at (195,70), `…` at (352,137 → 70 when scrolled) | tab bar hidden, floating undo (48,710) and X (48,773) |
| Like sheet | `Send Like` at y≈500 with keyboard, y≈604 without | comment box (195,410), rose (85,500), Send Like (250,500), `done` (340,743) |
| Likes You | title `Likes You` at y≈120 | empty state shows Boost / HingeX upsell |
| Matches | title `Matches` | sections: Your turn, Their turn, Hidden |
| Standouts | title `Standouts` + `Roses (0)` | horizontal cards, rose-only likes |
| Profile | `Hinge+` title, `Get more` / `Safety` / `My Hinge` tabs | account is Hinge+ |

## Discover card anatomy

Vertical scroll, one person per card. Five to six full swipes reach the end.

- Photo cards: full-width image, heart at (336, card bottom − 35).
- Prompt cards: white card with prompt label, answer text, heart bottom-right.
- Vitals card: age, height, location, job, school, religion, hometown, dating
  intention, relationship type (each an icon + text row). This is the most
  reliable structured data on the card.
- Floating undo + X are pinned bottom-left and never scroll away.

## Like flow

Tap any heart → like sheet (comment optional, rose optional) → `Send Like`.
To back out: tap `done` to drop the keyboard, then swipe the sheet down from
(195,130) to (195,700). Tapping the dimmed header does not dismiss it.

## Shadow mode

```
IOS_UDID=00008110-000E403E1AC2401E WDA_URL=http://127.0.0.1:8101 npm run hinge:shadow
```

The agent never taps. It polls a screenshot every 0.8 s, classifies it, and
groups frames by the header name. A profile is closed when the next name is
read twice in a row; its decision is `like` if the like sheet was seen while
that profile was open, else `pass`. Output under `data/hinge/shadow/<session>/`
(git-ignored): one folder per profile with de-duplicated frames and
`meta.json`, plus `session.jsonl`. Ctrl+C ends the session; the open profile
is recorded as `unknown`.

Known limits: a like sheet that is opened and then dismissed still counts as
`like`; profiles skipped in under two polls are missed; names OCR'd
differently mid-card can split a profile in two.
