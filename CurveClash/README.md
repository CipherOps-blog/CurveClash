# Curve Clash

A static, zero-build 2D equation battle game made with HTML, CSS, Canvas, and vanilla JavaScript. Math expressions are parsed by math.js and rendered with KaTeX. There is no Node runtime, application server, API, or backend.

## Run locally

Deploy the folder unchanged to any static host (for example GitHub Pages, Netlify, or a basic web server). No installation, package manager, build step, or server-side code is required.

For local development, the browser must receive the ES modules over HTTP rather than `file://`. Any static-file server works; Python is one optional convenience:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

This command only serves files; it is not a game backend. The first load needs internet access for the pinned math.js, KaTeX, and font assets.

## Equation input

- Type only the right-hand expression; the purple `f(x)` box and adjacent `=` are supplied by the interface.
- Accepted: `x^2 - 1`, `0.5 * x`, `45 * sin(x / 55)`
- Rejected: functions without a zero such as `x^2 + 1`, `min()` or `max()`, expressions using `y`, and implicit equations such as `x^2 + y^2 = 1`

Only `x` may vary, and the function must meet `y = 0` within the playable local `x` range. Coordinates use the firing player's position as the local `(0,0)`, with positive `y` pointing upward. In Live Visualizer mode, dashed curves are previews only; they cannot eliminate players or change terrain.

## Structure

- `index.html` — configuration, game HUD, and dialogs
- `styles.css` — responsive pastel/dark visual system
- `app.js` — game state, turns, bots, animation, and Canvas rendering
- `src/equation-engine.js` — strict function parsing, sampling, collision, and bot equations
- `src/bot-planner.js` — terrain-aware bot routing, smooth harmonic curves, exact hinge splines, and difficulty deformation
- `src/beam.js` — shared tapered-beam hit geometry and obstacle-occlusion checks
- `src/powerups.js` — buried shield/beam placement, exposure, and pickup detection
- `src/scoring.js` — obstacle-weighted kill values, multi-kill bonuses, and deterministic ranking
- `src/obstacle-field.js` — mutable pixel-grid terrain and circular craters

## Buried power-ups

Each match contains exactly one shield and one beam, visibly embedded deep
inside obstacles. Their solid burial depth is greater than the largest possible
single crater, and distinct-shot tracking prevents two impacts from the same
equation from counting as two moves. A cache therefore requires at least two
official shots to expose and collect. The shooter who completes that breach
wins the item.

- The shield absorbs one official hit. It persists across turns and disappears
  only when it actually blocks a hit; that contact awards no kill or points.
- The beam persists for its owner and wraps future centerlines in a tapered
  cone. It begins narrow and widens with traveled distance. The centerline still
  stops at the first obstacle, and lateral beam contacts cannot pass through
  solid terrain.

## Replay

The final ranking screen includes **View replay**. Replay restores the starting
arena and plays the official shots in their original order, including beam
width, shield blocks, eliminations, pickups, and the exact crater radii that
occurred. It uses an in-memory event log and remains entirely client-side; it
does not recompute bot decisions or contact outcomes. **Back to results** can
stop playback at any point and restores the exact final state.

## Scoring and ranking

A kill's base value is the straight-line distance from shooter to target plus
the length of that same segment lying inside obstacles. In other words, clear
distance counts once and blocked distance counts twice. The calculation walks
the authoritative pixel grid before the current shot creates any craters.

For a multi-kill, base values are sorted from smallest to largest and receive
increasing multipliers. Three values `x < y < z` therefore award
`x × 1 + y × 2 + z × 3`. The live roster is ordered by score, and the final
winner is the top-ranked player—even if that player was eliminated. Ties are
resolved by kills, survival, then the fixed turn order.

## Terrain-aware bots

Bots do not aim as if the arena were empty. Every unperturbed shot is first
traced through the authoritative obstacle grid. If the direct, parabolic, and
cubic families are blocked, a monotone-x route search finds a free corridor,
adds obstacle clearance, simplifies the route, and converts it into either a
smooth harmonic function or an exact piecewise-linear hinge function. The
result is accepted only after the normal production collision engine proves
that it reaches the selected target.

Difficulty is applied after that verified perfect equation has been selected,
so changing accuracy never changes the bot's intended strategy. If no graph of
an `f(x)` function can cross the terrain—such as a solid wall spanning the
whole map—the bot deliberately strikes the best obstruction point. Its crater
changes the collision grid, and the next turn replans against the opening.
