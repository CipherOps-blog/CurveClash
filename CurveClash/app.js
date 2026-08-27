import {
  buildCurvePlan,
  chooseBotShot,
  chooseNeutralTarget,
  equationToLatex,
  parseEquation
} from "./src/equation-engine.js";
import { buildRouteShot, planTerrainRoutes } from "./src/bot-planner.js";
import { beamRadiusAtDistance, buildCombatHitEvents } from "./src/beam.js";
import { ObstacleField } from "./src/obstacle-field.js";
import {
  MAX_CRATER_RADIUS,
  isImpactNearPowerUp,
  placeBuriedPowerUps,
  updatePowerUpExposure
} from "./src/powerups.js";
import { rankPlayers, scoreMultiKill } from "./src/scoring.js";

const MAP_SIZES = {
  small: { width: 900, height: 560 },
  medium: { width: 1200, height: 720 },
  large: { width: 1500, height: 900 }
};

const PLAYER_COLORS = ["#efadc1", "#a8dcc7", "#bfb4e5", "#f2c5a7", "#a9d7e6", "#e8b5e2"];
const BOT_NAMES = ["Ada", "Euclid", "Noether", "Gauss", "Hypatia", "Ramanujan", "Turing", "Euler"];
const PLAYER_HIT_RADIUS = 26;
const PREVIEW_DEBOUNCE = 130;
const MIN_CRATER_RADIUS = 12;
const POWERUP_PICKUP_RADIUS = 13;
const SCORE_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

class CurveClashGame {
  constructor() {
    this.dom = {
      configScreen: $("#config-screen"),
      gameScreen: $("#game-screen"),
      configForm: $("#config-form"),
      botCount: $("#bot-count"),
      botCountOutput: $("#bot-count-output"),
      difficulty: $("#difficulty"),
      difficultyOutput: $("#difficulty-output"),
      difficultyField: $("#difficulty-field"),
      behaviorHelp: $("#behavior-help"),
      themeToggle: $("#theme-toggle"),
      themeIcon: $("#theme-toggle .theme-icon"),
      newGameButton: $("#new-game-btn"),
      stopReplayButton: $("#stop-replay-btn"),
      canvasWrap: $("#canvas-wrap"),
      canvas: $("#game-canvas"),
      phaseLabel: $("#phase-label"),
      turnNumber: $("#turn-number"),
      timer: $("#timer-display"),
      aliveCount: $("#alive-count"),
      playerList: $("#player-list"),
      turnOrder: $("#turn-order"),
      equationReveal: $("#equation-reveal"),
      submissionCount: $("#submission-count"),
      equationDock: $("#equation-dock"),
      equationForm: $("#equation-form"),
      equationInput: $("#equation-input"),
      validateButton: $("#validate-btn"),
      latexPreview: $("#latex-preview"),
      equationHelp: $("#equation-help"),
      equationError: $("#equation-error"),
      inputModeLabel: $("#input-mode-label"),
      examplesToggle: $("#examples-toggle"),
      examplesPanel: $("#examples-panel"),
      stageBanner: $("#stage-banner"),
      toastStack: $("#toast-stack"),
      revealModal: $("#reveal-modal"),
      modalEquations: $("#modal-equations"),
      revealCountdown: $("#reveal-countdown"),
      endOverlay: $("#end-overlay"),
      endCard: $("#end-overlay .end-card"),
      endEmblem: $("#end-emblem"),
      endKicker: $("#end-kicker"),
      endTitle: $("#end-title"),
      endMessage: $("#end-message"),
      endRanking: $("#end-ranking"),
      endStats: $("#end-stats"),
      replayButton: $("#view-replay-btn"),
      playAgainButton: $("#play-again-btn"),
      sameSettingsButton: $("#same-settings-btn")
    };

    this.context = this.dom.canvas.getContext("2d");
    this.state = null;
    this.runtimeVersion = 0;
    this.timerInterval = null;
    this.previewTimer = null;
    this.previewVersion = 0;
    this.bannerTimer = null;
    this.lastFrameTime = performance.now();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.bindInterface();
    this.restoreTheme();
    this.syncConfigurationControls();
    this.resizeObserver = new ResizeObserver(() => this.fitCanvas());
    this.resizeObserver.observe(this.dom.canvasWrap);
    requestAnimationFrame((time) => this.renderLoop(time));

    // A small, intentional test/debug surface. It is also handy for educators
    // who want to inspect the current equation and obstacle-grid revision.
    window.curveClash = this;
  }

  bindInterface() {
    this.dom.configForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.startGame(this.readConfiguration());
    });

    $$("[data-step]", this.dom.configForm).forEach((button) => {
      button.addEventListener("click", () => {
        const next = clamp(Number(this.dom.botCount.value) + Number(button.dataset.step), 1, 5);
        this.dom.botCount.value = String(next);
        this.dom.botCountOutput.value = String(next);
      });
    });

    this.dom.botCount.addEventListener("input", () => {
      const count = clamp(Number(this.dom.botCount.value) || 1, 1, 5);
      this.dom.botCount.value = String(count);
      this.dom.botCountOutput.value = String(count);
    });

    this.dom.difficulty.addEventListener("input", () => {
      this.dom.difficultyOutput.value = `${this.dom.difficulty.value}%`;
    });
    $$("input[name='peaceful']", this.dom.configForm).forEach((input) => {
      input.addEventListener("change", () => this.syncConfigurationControls());
    });

    this.dom.themeToggle.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      this.setTheme(next);
    });

    this.dom.newGameButton.addEventListener("click", () => this.showConfiguration());
    this.dom.stopReplayButton.addEventListener("click", () => this.stopReplay());
    this.dom.replayButton.addEventListener("click", () => this.playReplay());
    this.dom.playAgainButton.addEventListener("click", () => this.showConfiguration());
    this.dom.sameSettingsButton.addEventListener("click", () => {
      if (this.state?.config) this.startGame({ ...this.state.config });
    });

    this.dom.equationInput.addEventListener("input", () => this.handleEquationInput());
    this.dom.equationForm.addEventListener("submit", (event) => this.validateHumanEquation(event));

    this.dom.examplesToggle.addEventListener("click", () => {
      const hidden = this.dom.examplesPanel.classList.toggle("is-hidden");
      this.dom.examplesToggle.setAttribute("aria-expanded", String(!hidden));
    });
    $$('[data-equation]', this.dom.examplesPanel).forEach((button) => {
      button.addEventListener("click", () => {
        this.dom.equationInput.value = button.dataset.equation;
        this.dom.examplesPanel.classList.add("is-hidden");
        this.dom.examplesToggle.setAttribute("aria-expanded", "false");
        this.handleEquationInput(true);
        this.dom.equationInput.focus();
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.dom.examplesPanel.classList.add("is-hidden");
        this.dom.examplesToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  restoreTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("curve-clash-theme");
    } catch {
      // Storage can be unavailable in privacy-focused browser contexts.
    }
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    this.setTheme(saved === "dark" || saved === "light" ? saved : preferred);
  }

  setTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    this.dom.themeToggle.setAttribute("aria-pressed", String(isDark));
    this.dom.themeToggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
    this.dom.themeIcon.textContent = isDark ? "☀" : "☾";
    $("meta[name='theme-color']")?.setAttribute("content", isDark ? "#1e1e2e" : "#faf8f5");
    try {
      localStorage.setItem("curve-clash-theme", isDark ? "dark" : "light");
    } catch {
      // Theme still works for the current page when storage is blocked.
    }
    this.state?.field?.rebuildVisual(isDark);
  }

  syncConfigurationControls() {
    const peaceful = $("input[name='peaceful']:checked", this.dom.configForm)?.value === "true";
    this.dom.difficulty.disabled = peaceful;
    this.dom.difficultyField.classList.toggle("is-disabled", peaceful);
    this.dom.difficultyField.setAttribute("aria-disabled", String(peaceful));
    this.dom.behaviorHelp.textContent = peaceful
      ? "Bots plot toward empty, fictional targets and never deliberately aim at you."
      : "Each bot randomly targets another survivor, human or bot.";
    this.dom.botCountOutput.value = this.dom.botCount.value;
    this.dom.difficultyOutput.value = `${this.dom.difficulty.value}%`;
  }

  readConfiguration() {
    const checkedValue = (name) => $(`input[name='${name}']:checked`, this.dom.configForm)?.value;
    return {
      botCount: clamp(Number(this.dom.botCount.value) || 3, 1, 5),
      peaceful: checkedValue("peaceful") === "true",
      difficulty: clamp(Number(this.dom.difficulty.value) || 0, 0, 100),
      mapSize: checkedValue("mapSize") || "medium",
      density: checkedValue("density") || "medium",
      inputMode: checkedValue("inputMode") || "live",
      timer: [180, 240, 300].includes(Number(checkedValue("timer"))) ? Number(checkedValue("timer")) : 180
    };
  }

  startGame(config) {
    if (!window.math || !window.katex) {
      window.alert("The mathematics libraries could not be loaded. Check your connection, then reload the page.");
      return;
    }

    this.cancelRuntime();
    const version = this.runtimeVersion;
    const dimensions = MAP_SIZES[config.mapSize] ?? MAP_SIZES.medium;
    const field = new ObstacleField(dimensions.width, dimensions.height, 4);
    field.generate(config.density);

    const shuffledNames = shuffle([...BOT_NAMES]);
    const players = [];
    for (let index = 0; index < config.botCount + 1; index += 1) {
      const position = field.randomClearPosition(PLAYER_HIT_RADIUS, players);
      players.push({
        id: index === 0 ? "human" : `bot-${index}`,
        name: index === 0 ? "You" : shuffledNames[index - 1],
        color: PLAYER_COLORS[index % PLAYER_COLORS.length],
        x: position.x,
        y: position.y,
        hitRadius: PLAYER_HIT_RADIUS,
        bodyRadius: 14,
        isHuman: index === 0,
        alive: true,
        removed: false,
        eliminatedThisTurn: false,
        equation: null,
        parsed: null,
        validated: false,
        target: null,
        lastTargetId: null,
        botStrategy: null,
        botRouteDiagnostics: null,
        botReachesTarget: null,
        kills: 0,
        score: 0,
        scoreUnits: 0,
        scoreHistory: [],
        shieldCharges: 0,
        hasBeam: false
      });
    }
    const bounds = { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
    const powerUps = placeBuriedPowerUps({ field, bounds, players });
    for (const powerUp of powerUps) powerUp.breachShotIds = [];
    field.rebuildVisual(document.documentElement.dataset.theme === "dark");

    this.state = {
      config,
      width: dimensions.width,
      height: dimensions.height,
      bounds,
      field,
      players,
      powerUps,
      turnOrder: shuffle(players.map((player) => player.id)),
      turn: 1,
      phase: "setup",
      inputDeadline: null,
      remainingSeconds: config.timer,
      currentShooterId: null,
      preview: null,
      traces: [],
      currentTrace: null,
      particles: [],
      nextShotId: 1,
      activeShotRecord: null,
      stats: {
        shots: 0,
        humanShots: 0,
        craters: 0,
        totalEliminations: 0,
        totalPoints: 0,
        totalPointUnits: 0,
        powerUpsCollected: 0
      },
      closingInput: false,
      replay: {
        shots: [],
        playing: false,
        initialSnapshot: null,
        finalSnapshot: null
      }
    };
    this.state.replay.initialSnapshot = this.captureReplaySnapshot();

    this.dom.canvas.width = dimensions.width;
    this.dom.canvas.height = dimensions.height;
    this.dom.configScreen.classList.add("is-hidden");
    this.dom.gameScreen.classList.remove("is-hidden");
    this.dom.revealModal.classList.add("is-hidden");
    this.dom.endOverlay.classList.add("is-hidden");
    this.dom.stopReplayButton.classList.add("is-hidden");
    this.dom.equationDock.style.setProperty("--player-color", players[0].color);
    this.updateAllInterface();
    requestAnimationFrame(() => this.fitCanvas());
    this.beginInputPhase(version);
  }

  cancelRuntime() {
    this.runtimeVersion += 1;
    clearInterval(this.timerInterval);
    clearTimeout(this.previewTimer);
    clearTimeout(this.bannerTimer);
    this.timerInterval = null;
    this.previewTimer = null;
    this.previewVersion += 1;
    this.dom.revealModal.classList.add("is-hidden");
    this.dom.endOverlay.classList.add("is-hidden");
    this.dom.stopReplayButton.classList.add("is-hidden");
  }

  showConfiguration() {
    this.cancelRuntime();
    this.state = null;
    this.dom.gameScreen.classList.add("is-hidden");
    this.dom.configScreen.classList.remove("is-hidden");
    this.dom.revealModal.classList.add("is-hidden");
    this.dom.endOverlay.classList.add("is-hidden");
  }

  async beginInputPhase(version = this.runtimeVersion) {
    if (!this.isCurrent(version) || !this.state) return;
    const state = this.state;
    state.phase = "input";
    state.closingInput = false;
    state.currentShooterId = null;
    state.preview = null;
    state.currentTrace = null;
    state.traces = [];
    state.particles = [];

    for (const player of state.players) {
      // The end-of-turn pause has finished; eliminated icons now leave the map
      // and must not keep producing a skipped slot in later rounds.
      player.eliminatedThisTurn = false;
      if (!player.alive) continue;
      player.equation = null;
      player.parsed = null;
      player.validated = false;
      player.target = null;
      player.perfectEquation = null;
      player.botStrategy = null;
      player.botRouteDiagnostics = null;
      player.botReachesTarget = null;
    }

    // Bot work starts immediately but yields between actors so the arena,
    // countdown, and human input remain responsive on large/high-density maps.
    state.botReadyPromise = this.prepareBotEquations(version);
    this.resetEquationDock();
    this.resetEquationReveal();
    this.clearBanner();
    this.updateAllInterface();

    const livingHumans = state.players.filter((player) => player.alive && player.isHuman);
    if (!livingHumans.length) {
      this.dom.equationInput.disabled = true;
      this.dom.equationInput.placeholder = "Spectating the remaining bot battle";
      this.dom.validateButton.disabled = true;
      this.dom.validateButton.textContent = "Spectating";
      this.dom.timer.textContent = "00:01";
      this.showBanner("You are out — the remaining curves will resolve automatically.", "quiet");
      await delay(this.reducedMotion ? 250 : 900);
      if (this.isCurrent(version) && state.phase === "input") this.closeInputPhase("bots-ready", version);
      return;
    }

    state.inputDeadline = Date.now() + state.config.timer * 1000;
    state.remainingSeconds = state.config.timer;
    this.updateTimer();
    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      if (!this.isCurrent(version) || this.state?.phase !== "input") {
        clearInterval(this.timerInterval);
        return;
      }
      state.remainingSeconds = Math.max(0, Math.ceil((state.inputDeadline - Date.now()) / 1000));
      this.updateTimer();
      if (state.remainingSeconds <= 0) this.closeInputPhase("timeout", version);
    }, 250);
    requestAnimationFrame(() => this.dom.equationInput.focus({ preventScroll: true }));
  }

  async prepareBotEquations(version = this.runtimeVersion) {
    const state = this.state;
    if (!state) return;
    const living = state.players.filter((player) => player.alive);

    for (const bot of living.filter((player) => !player.isHuman)) {
      await delay(0);
      if (!this.isCurrent(version) || this.state !== state || state.phase !== "input") return;
      const target = state.config.peaceful
        ? this.findNeutralTarget(living)
        : this.chooseRandomOpponent(bot, living);
      const difficulty = state.config.peaceful ? 100 : state.config.difficulty;
      bot.target = target;

      try {
        const chosen = this.findBestBotCurve(bot, target, difficulty, living);
        bot.equation = chosen.equation;
        bot.perfectEquation = chosen.perfectEquation;
        bot.parsed = chosen.parsed;
        bot.validated = true;
        bot.botOffset = chosen.offset;
        bot.botStrategy = chosen.strategy;
        bot.botRouteDiagnostics = chosen.diagnostics ?? null;
        bot.botReachesTarget = Boolean(chosen.reachesTarget);
      } catch (error) {
        console.warn("Bot equation fallback", error);
        bot.equation = "f(x) = 0";
        bot.perfectEquation = "f(x) = 0";
        bot.parsed = parseEquation(bot.equation, window.math);
        bot.validated = true;
        bot.botStrategy = "fallback";
        bot.botRouteDiagnostics = null;
        bot.botReachesTarget = false;
      }
      this.updateSubmissionCount();
      this.updateRoster();
    }
  }

  chooseRandomOpponent(bot, livingPlayers) {
    const opponents = livingPlayers.filter((player) => player.id !== bot.id);
    if (!opponents.length) return this.findNeutralTarget(livingPlayers);

    // Keep every living actor eligible, but avoid visibly tunnelling the same
    // target when another opponent is available. The first pick is uniform.
    const freshOpponents = opponents.filter((player) => player.id !== bot.lastTargetId);
    const target = randomItem(freshOpponents.length ? freshOpponents : opponents);
    bot.lastTargetId = target.id;
    return target;
  }

  findNeutralTarget(players) {
    const state = this.state;
    let target = null;
    for (let attempt = 0; attempt < 18; attempt += 1) {
      target = chooseNeutralTarget({ bounds: state.bounds, players, margin: 58 });
      if (state.field.isCircleClear(target.x, target.y, 12, 3)) return target;
    }
    return target ?? { x: state.width / 2, y: state.height / 2 };
  }

  findBestBotCurve(bot, target, difficulty, livingPlayers) {
    const state = this.state;
    const localX = target.x - bot.x;
    const candidateSpecs = [{ style: "line" }];
    if (Math.abs(localX) >= 16) {
      const deviations = [28, -28, 55, -55, 90, -90, 140, -140, 210, -210, 300, -300];
      for (const deviation of deviations) {
        candidateSpecs.push({ style: "parabola", shapeParameter: -4 * deviation / (localX ** 2) });
      }
    }
    const distance = Math.hypot(target.x - bot.x, target.y - bot.y);
    const cubicDetours = [35, -35, 70, -70, 120, -120, 190, -190];
    for (const detour of cubicDetours) {
      candidateSpecs.push({ style: "cubic", shapeParameter: { arch: detour * 4, wave: 0 } });
    }
    for (const detour of [45, -45, 90, -90, 150, -150]) {
      candidateSpecs.push({
        style: "cubic",
        shapeParameter: { arch: detour * 1.8, wave: detour * 10.4 }
      });
    }

    const targetRadius = target?.hitRadius ?? 22;
    const planningStarted = performance.now();
    let evaluatedCandidates = 0;
    let bestBreach = null;

    const assess = (perfectEquation, metadata = {}) => {
      const parsed = parseEquation(perfectEquation, window.math);
      const plan = this.createCurvePlan(parsed, bot, livingPlayers, 1.05);
      const targetDistance = distanceToPaths(plan.paths, target);
      const reachesTarget = target?.id
        ? plan.hitIds.includes(target.id)
        : targetDistance <= targetRadius;
      const assessment = {
        ...metadata,
        perfectEquation,
        perfectParsed: parsed,
        perfectPlan: plan,
        reachesTarget,
        score: reachesTarget ? 0 : targetDistance
      };
      evaluatedCandidates += 1;
      if (!bestBreach || assessment.score < bestBreach.score) bestBreach = assessment;
      return assessment;
    };

    for (const spec of candidateSpecs) {
      // First prove that the unperturbed equation reaches the target through
      // the current terrain. Difficulty is deliberately applied only after a
      // perfect, collision-valid family has been selected.
      const perfect = chooseBotShot(bot, target, 100, null, {
        math: window.math,
        style: spec.style,
        shapeParameter: spec.shapeParameter,
        maxOffset: 340,
        random: () => 0.5
      });
      const assessment = assess(perfect.perfectEquation, { type: "analytic", spec });
      if (!assessment.reachesTarget) continue;
      const shot = chooseBotShot(bot, target, difficulty, null, {
        math: window.math,
        style: spec.style,
        shapeParameter: spec.shapeParameter,
        maxOffset: 340
      });
      return {
        ...shot,
        parsed: parseEquation(shot.equation, window.math),
        score: 0,
        reachesTarget: true,
        strategy: spec.style === "line" ? "direct" : "analytic-clear",
        diagnostics: {
          evaluatedCandidates,
          terrainRevision: state.field.revision,
          planningMs: performance.now() - planningStarted,
          family: spec.style
        }
      };
    }

    // Analytic curves failed, so search the actual free-space topology. The
    // layered planner only moves monotonically in x (the legal geometry of an
    // f(x) graph), inflates obstacles, and string-pulls the resulting route.
    const routeCandidates = planTerrainRoutes({
      origin: bot,
      target,
      bounds: state.bounds,
      terrain: state.field,
      targetRadius,
      maxRoutes: 5,
      maxRoutePoints: 15
    });
    for (const routeCandidate of routeCandidates) {
      // A harmonic interpolation gives smooth, sophisticated curves when it
      // stays inside the corridor. The exact hinge spline is verified next and
      // is guaranteed to follow every planned segment without cutting corners.
      for (const family of ["harmonic", "hinge"]) {
        const perfectShot = buildRouteShot(routeCandidate, {
          origin: bot,
          target,
          difficulty: 100,
          family,
          random: () => 0.5,
          maxOffset: 340
        });
        let assessment;
        try {
          assessment = assess(perfectShot.perfectEquation, {
            type: "route",
            routeCandidate,
            family
          });
        } catch {
          continue;
        }
        if (!assessment.reachesTarget) continue;

        const shot = buildRouteShot(routeCandidate, {
          origin: bot,
          target,
          difficulty,
          family,
          maxOffset: 340
        });
        return {
          ...shot,
          parsed: parseEquation(shot.equation, window.math),
          score: 0,
          reachesTarget: true,
          strategy: routeCandidate.strategy,
          diagnostics: {
            ...shot.diagnostics,
            evaluatedCandidates,
            availableRoutes: routeCandidates.length,
            terrainRevision: state.field.revision,
            planningDistance: distance,
            planningMs: performance.now() - planningStarted
          }
        };
      }
    }

    // A full-height barrier can make every single-valued route impossible.
    // In that case, deliberately fire the best blocked analytic shot so its
    // crater opens the frontier; the next turn replans against the new grid.
    if (bestBreach?.spec) {
      const shot = chooseBotShot(bot, target, difficulty, null, {
        math: window.math,
        style: bestBreach.spec.style,
        shapeParameter: bestBreach.spec.shapeParameter,
        maxOffset: 340
      });
      return {
        ...shot,
        parsed: parseEquation(shot.equation, window.math),
        score: bestBreach.score,
        reachesTarget: false,
        strategy: "breach",
        diagnostics: {
          evaluatedCandidates,
          availableRoutes: routeCandidates.length,
          terrainRevision: state.field.revision,
          planningMs: performance.now() - planningStarted,
          reason: "No collision-free monotone-x route exists yet"
        }
      };
    }

    throw new Error("No finite bot route could be generated.");
  }

  resetEquationDock() {
    const state = this.state;
    const human = state?.players.find((player) => player.isHuman);
    const canInput = Boolean(human?.alive);
    this.dom.equationInput.value = "";
    this.dom.equationInput.disabled = !canInput;
    this.dom.equationInput.placeholder = canInput
      ? "0.5 * x"
      : "Spectating the remaining bot battle";
    this.dom.equationInput.classList.remove("is-valid", "is-invalid");
    this.dom.equationInput.setAttribute("aria-invalid", "false");
    this.dom.validateButton.disabled = !canInput;
    this.dom.validateButton.classList.remove("is-validated", "validated");
    this.dom.validateButton.textContent = canInput ? "Validate shot" : "Spectating";
    this.dom.equationError.textContent = "";
    this.dom.inputModeLabel.textContent = state?.config.inputMode === "plain" ? "Plain text mode" : "Live visualizer";
    this.dom.equationHelp.textContent = state?.config.inputMode === "plain"
      ? "Type only the expression after f(x) =. It must reach y = 0; min() and max() are unavailable. Interpretation appears after validation."
      : "Type only the expression after f(x) =. It must reach y = 0; min() and max() are unavailable.";
    this.dom.latexPreview.classList.toggle("plain-mode", state?.config.inputMode === "plain");
    this.setLatexPlaceholder(state?.config.inputMode === "plain" ? "Preview hidden until validation" : "Your equation will appear here");
  }

  resetEquationReveal() {
    this.dom.equationReveal.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Equations stay secret until the input phase closes.";
    this.dom.equationReveal.append(empty);
  }

  handleEquationInput(immediate = false) {
    const state = this.state;
    const human = state?.players.find((player) => player.isHuman);
    if (!state || state.phase !== "input" || state.closingInput || state.config.inputMode !== "live" || !human?.alive || human.validated) return;

    clearTimeout(this.previewTimer);
    const request = ++this.previewVersion;
    const run = () => {
      if (request !== this.previewVersion || this.state?.phase !== "input") return;
      const source = this.dom.equationInput.value.trim();
      state.preview = null;
      this.dom.equationError.textContent = "";
      this.dom.equationInput.classList.remove("is-valid", "is-invalid");
      this.dom.equationInput.setAttribute("aria-invalid", "false");
      if (!source) {
        this.setLatexPlaceholder("Your equation will appear here");
        return;
      }

      try {
        const parsed = parseEquation(source, window.math);
        const plan = this.createCurvePlan(parsed, human, state.players.filter((player) => player.alive), 1.35);
        if (!plan.paths.length) throw new Error("This curve does not enter the playable map from your local origin.");
        state.preview = { ...plan, shooterId: human.id, color: human.color };
        this.dom.equationInput.classList.add("is-valid");
        this.dom.equationInput.setAttribute("aria-invalid", "false");
        this.renderLatex(this.dom.latexPreview, equationToLatex(parsed, window.math));
      } catch (error) {
        state.preview = null;
        this.dom.equationInput.classList.add("is-invalid");
        this.dom.equationInput.setAttribute("aria-invalid", "true");
        this.dom.equationError.textContent = friendlyEquationError(error);
        this.setLatexPlaceholder("Keep typing…");
      }
    };
    if (immediate) run();
    else this.previewTimer = setTimeout(run, PREVIEW_DEBOUNCE);
  }

  validateHumanEquation(event) {
    event.preventDefault();
    const state = this.state;
    const human = state?.players.find((player) => player.isHuman);
    if (!state || state.phase !== "input" || state.closingInput || !human?.alive || human.validated) return;
    const source = this.dom.equationInput.value.trim();
    if (!source) {
      this.dom.equationInput.classList.add("is-invalid");
      this.dom.equationInput.setAttribute("aria-invalid", "true");
      this.dom.equationError.textContent = "Enter an expression before validating, or let the timer submit a null shot.";
      return;
    }

    try {
      const parsed = parseEquation(source, window.math);
      const plan = this.createCurvePlan(parsed, human, state.players.filter((player) => player.alive), 1.1);
      if (!plan.paths.length) throw new Error("This curve does not enter the playable map from your local origin.");
      human.equation = source;
      human.parsed = parsed;
      human.validated = true;
      state.preview = state.config.inputMode === "live" ? { ...plan, shooterId: human.id, color: human.color } : null;
      this.dom.equationInput.classList.remove("is-invalid");
      this.dom.equationInput.classList.add("is-valid");
      this.dom.equationInput.setAttribute("aria-invalid", "false");
      this.dom.equationInput.disabled = true;
      this.dom.validateButton.disabled = true;
      this.dom.validateButton.classList.add("is-validated");
      this.dom.validateButton.textContent = "Locked ✓";
      this.dom.equationError.textContent = "";
      this.renderLatex(this.dom.latexPreview, equationToLatex(parsed, window.math));
      this.updateSubmissionCount();
      this.showBanner("Equation locked — revealing every curve…", "success");

      const allHumansReady = state.players.filter((player) => player.alive && player.isHuman).every((player) => player.validated);
      if (allHumansReady) {
        const version = this.runtimeVersion;
        setTimeout(() => this.closeInputPhase("ready", version), this.reducedMotion ? 120 : 520);
      }
    } catch (error) {
      state.preview = null;
      this.dom.equationInput.classList.add("is-invalid");
      this.dom.equationInput.setAttribute("aria-invalid", "true");
      this.dom.equationError.textContent = friendlyEquationError(error);
    }
  }

  createCurvePlan(parsed, shooter, players, collisionStep = 0.9) {
    const state = this.state;
    const plan = buildCurvePlan(parsed, shooter, state.bounds, state.field, {
      math: window.math,
      players,
      shooterId: shooter.id,
      hitRadius: PLAYER_HIT_RADIUS,
      anchorToOrigin: false,
      requirePlayableZero: true,
      step: 3,
      maxSamples: 18000,
      collisionStep
    });
    const combatEvents = buildCombatHitEvents({
      paths: plan.paths,
      shooter,
      players,
      terrain: state.field,
      beam: Boolean(shooter.hasBeam),
      defaultHitRadius: PLAYER_HIT_RADIUS
    });
    plan.hitEvents = combatEvents;
    plan.hitIds = combatEvents.map((event) => event.playerId);
    plan.hits = [...plan.hitIds];
    plan.beam = Boolean(shooter.hasBeam);
    return plan;
  }

  async closeInputPhase(reason = "ready", version = this.runtimeVersion) {
    const state = this.state;
    if (!state || !this.isCurrent(version) || state.phase !== "input" || state.closingInput) return;
    state.closingInput = true;
    clearInterval(this.timerInterval);
    clearTimeout(this.previewTimer);
    state.preview = null;
    this.dom.equationInput.disabled = true;
    this.dom.validateButton.disabled = true;
    this.dom.validateButton.textContent = reason === "timeout" ? "Time expired" : "Locked";

    // A very fast human submission can beat a bot's yielded computation. The
    // input phase stays closed to edits while those already-started choices
    // finish, then reveals everyone together.
    await state.botReadyPromise;
    if (!this.isCurrent(version) || this.state !== state || state.phase !== "input") return;

    for (const player of state.players) {
      if (!player.alive || player.validated) continue;
      player.equation = null;
      player.parsed = null;
      player.validated = true;
    }

    state.phase = "reveal";
    this.dom.timer.textContent = "00:00";
    this.clearBanner();
    this.populateEquationReveal();
    this.updateAllInterface();
    this.dom.revealModal.classList.remove("is-hidden");

    for (let count = 3; count >= 1; count -= 1) {
      if (!this.isCurrent(version)) return;
      this.dom.revealCountdown.textContent = String(count);
      await delay(this.reducedMotion ? 300 : 850);
    }
    if (!this.isCurrent(version)) return;
    this.dom.revealModal.classList.add("is-hidden");
    await this.runSimulation(version);
  }

  populateEquationReveal() {
    const participants = this.state.players.filter((player) => !player.removed && player.validated);
    this.dom.equationReveal.replaceChildren();
    const sideList = document.createElement("ol");
    sideList.className = "equation-list";
    for (const player of participants) sideList.append(this.createEquationItem(player, "side"));
    this.dom.equationReveal.append(sideList);

    this.dom.modalEquations.replaceChildren();
    const modalList = document.createElement("ol");
    modalList.className = "reveal-list";
    participants.forEach((player, index) => modalList.append(this.createEquationItem(player, "modal", index)));
    this.dom.modalEquations.append(modalList);
  }

  createEquationItem(player, placement, index = 0) {
    const item = document.createElement("li");
    item.style.setProperty("--player-color", player.color);
    if (placement === "modal") {
      item.className = "reveal-item";
      item.style.setProperty("--item-index", String(index));
      const header = document.createElement("div");
      header.className = "reveal-player";
      const name = document.createElement("span");
      name.textContent = player.name;
      const type = document.createElement("small");
      type.textContent = player.isHuman ? "Human" : "Bot";
      header.append(name, type);
      const equation = document.createElement("div");
      equation.className = "reveal-equation";
      if (player.parsed) this.renderLatex(equation, equationToLatex(player.parsed, window.math));
      else equation.textContent = "No equation — null shot";
      item.append(header, equation);
      return item;
    }

    item.className = "equation-item";
    const header = document.createElement("div");
    header.className = "equation-item-header";
    const color = document.createElement("i");
    color.className = "equation-color";
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.name;
    header.append(color, name);
    const equation = document.createElement("div");
    equation.className = "equation-latex";
    if (player.parsed) this.renderLatex(equation, equationToLatex(player.parsed, window.math));
    else equation.textContent = "∅  Null shot";
    item.append(header, equation);
    return item;
  }

  async runSimulation(version = this.runtimeVersion) {
    const state = this.state;
    if (!state || !this.isCurrent(version)) return;
    state.phase = "simulation";
    state.currentShooterId = null;
    this.dom.phaseLabel.textContent = "Simulation";
    this.dom.timer.textContent = "—";
    this.dom.equationInput.disabled = true;
    this.dom.validateButton.disabled = true;
    this.dom.validateButton.textContent = "Tracing…";
    this.showBanner("Curves trace in the fixed order.", "quiet");
    this.updateAllInterface();
    await delay(this.reducedMotion ? 180 : 500);

    for (const playerId of state.turnOrder) {
      if (!this.isCurrent(version)) return;
      const shooter = state.players.find((player) => player.id === playerId);
      if (!shooter) continue;

      if (!shooter.alive) {
        if (shooter.eliminatedThisTurn) {
          state.currentShooterId = shooter.id;
          this.showBanner(`${shooter.name}'s shot is skipped — already eliminated.`, "skip");
          this.updateAllInterface();
          await delay(this.reducedMotion ? 220 : 800);
        }
        continue;
      }

      state.currentShooterId = shooter.id;
      this.updateAllInterface();
      if (!shooter.parsed) {
        this.showBanner(`${shooter.name} submitted no equation.`, "skip");
        await delay(this.reducedMotion ? 220 : 850);
        continue;
      }

      let plan;
      try {
        // Rebuild immediately before firing: earlier shots may have opened new
        // craters, and those holes must already be passable for this curve.
        plan = this.createCurvePlan(
          shooter.parsed,
          shooter,
          state.players.filter((player) => player.alive),
          0.8
        );
      } catch (error) {
        console.error("Could not trace submitted equation", error);
        this.showBanner(`${shooter.name}'s curve could not be traced.`, "skip");
        await delay(this.reducedMotion ? 220 : 850);
        continue;
      }

      if (!plan.paths.length) {
        this.showBanner(`${shooter.name}'s curve never enters the arena.`, "skip");
        await delay(this.reducedMotion ? 220 : 850);
        continue;
      }

      const shotRecord = this.beginShotRecord(shooter, plan);
      this.showBanner(`${shooter.name} is tracing ${shortEquationLabel(shooter.parsed)}.`, "active");
      await this.animateCurve(shooter, plan, version);
      if (!this.isCurrent(version)) return;

      // An already exposed cache can be collected only by a later official
      // centerline contact. Beam width alone never collects a power-up.
      this.collectExposedPowerUpsAlongTrace(shooter, plan.paths, shotRecord.id);

      // Let the completed shot visibly meet the intact wall before the impact
      // opens a crater. Without this paint window, both states can collapse
      // into one frame and make the curve look as though it simply vanished.
      await delay(this.reducedMotion ? 90 : 180);
      if (!this.isCurrent(version)) return;

      state.traces.push({
        paths: plan.paths,
        color: shooter.color,
        shooterId: shooter.id,
        beam: shotRecord.beam
      });
      state.currentTrace = null;
      state.stats.shots += 1;
      if (shooter.isHuman) state.stats.humanShots += 1;

      let craterCount = 0;
      for (const impact of plan.impacts.filter((entry) => entry.type === "terrain")) {
        const radius = MIN_CRATER_RADIUS + Math.random() * (MAX_CRATER_RADIUS - MIN_CRATER_RADIUS);
        this.registerPowerUpBreach(impact, radius, shotRecord.id);
        const removed = state.field.destroyCircle(impact.point.x, impact.point.y, radius);
        if (removed > 0) {
          craterCount += 1;
          state.stats.craters += 1;
          shotRecord.craters.push({ point: { ...impact.point }, radius });
          this.spawnBurst(impact.point.x, impact.point.y, "#f2c5a7", 16);
          this.collectNewlyExposedPowerUps(shooter);
        }
      }
      if (craterCount) this.showToast(`${craterCount} new passage${craterCount === 1 ? "" : "s"} opened`, "success");

      this.commitShotRecord(shotRecord);

      this.updateAllInterface();
      await delay(this.reducedMotion ? 320 : 1000);
    }

    if (!this.isCurrent(version)) return;
    await this.endTurn(version);
  }

  animateCurve(shooter, plan, version) {
    const state = this.state;
    const pointCount = plan.paths.reduce((sum, path) => sum + path.length, 0);
    const duration = this.reducedMotion ? 320 : clamp(1250 + pointCount * 0.055, 1350, 2300);
    const events = this.animationHitEvents(plan.paths, shooter);
    this.prepareShotScores(shooter, events);

    state.currentTrace = {
      paths: plan.paths,
      impacts: plan.impacts,
      color: shooter.color,
      progress: 0,
      shooterId: shooter.id,
      beam: Boolean(plan.beam)
    };
    return new Promise((resolve) => {
      const started = performance.now();
      const step = (now) => {
        if (!this.isCurrent(version) || this.state !== state) {
          resolve(false);
          return;
        }
        const progress = clamp((now - started) / duration, 0, 1);
        state.currentTrace.progress = progress;

        for (const event of events) {
          if (!event.handled && event.progress <= progress + 0.01) {
            event.handled = true;
            this.applyHit(shooter, event);
          }
        }

        if (progress < 1) requestAnimationFrame(step);
        else {
          for (const event of events.filter((entry) => !entry.handled)) {
            event.handled = true;
            this.applyHit(shooter, event);
          }
          resolve(true);
        }
      };
      requestAnimationFrame(step);
    });
  }

  animationHitEvents(paths, shooter) {
    return buildCombatHitEvents({
      paths,
      shooter,
      players: this.state.players,
      terrain: this.state.field,
      beam: Boolean(shooter.hasBeam),
      defaultHitRadius: PLAYER_HIT_RADIUS
    });
  }

  beginShotRecord(shooter, plan) {
    const state = this.state;
    const record = {
      id: state.nextShotId,
      turn: state.turn,
      shooterId: shooter.id,
      shooterName: shooter.name,
      color: shooter.color,
      equation: shooter.equation,
      beam: Boolean(plan.beam),
      paths: clonePaths(plan.paths),
      impacts: (plan.impacts ?? []).map((impact) => ({
        ...impact,
        point: impact.point ? { ...impact.point } : null
      })),
      outcomes: [],
      craters: [],
      pickups: []
    };
    state.nextShotId += 1;
    state.activeShotRecord = record;
    return record;
  }

  recordShotOutcome(outcome) {
    const record = this.state?.activeShotRecord;
    if (!record || !outcome) return;
    record.outcomes.push({
      ...outcome,
      point: outcome.point ? { ...outcome.point } : null,
      award: outcome.award ? { ...outcome.award } : null
    });
  }

  commitShotRecord(record) {
    const state = this.state;
    if (!state || state.activeShotRecord !== record) return;
    state.replay.shots.push(record);
    state.activeShotRecord = null;
  }

  registerPowerUpBreach(impact, craterRadius, shotId) {
    const state = this.state;
    for (const powerUp of state?.powerUps ?? []) {
      if (powerUp.collected) continue;
      if (!isImpactNearPowerUp(impact, powerUp, craterRadius, powerUp.burialRadius)) continue;
      if (!powerUp.breachShotIds.includes(shotId)) powerUp.breachShotIds.push(shotId);
    }
  }

  collectNewlyExposedPowerUps(shooter) {
    const state = this.state;
    if (!state) return;
    updatePowerUpExposure(state.powerUps, state.field);
    for (const powerUp of state.powerUps) {
      if (!powerUp.exposed || powerUp.collected) continue;
      if (new Set(powerUp.breachShotIds).size >= 2) this.awardPowerUp(shooter, powerUp);
    }
  }

  collectExposedPowerUpsAlongTrace(shooter, paths, shotId) {
    const state = this.state;
    if (!state) return;
    for (const powerUp of state.powerUps) {
      if (!powerUp.exposed || powerUp.collected) continue;
      if (distanceToPaths(paths, powerUp) > POWERUP_PICKUP_RADIUS) continue;
      if (!powerUp.breachShotIds.includes(shotId)) powerUp.breachShotIds.push(shotId);
      if (new Set(powerUp.breachShotIds).size >= 2) this.awardPowerUp(shooter, powerUp);
    }
  }

  awardPowerUp(player, powerUp) {
    const state = this.state;
    if (!state || !player?.alive || !powerUp || powerUp.collected) return false;
    powerUp.collected = true;
    powerUp.ownerId = player.id;
    powerUp.collectedTurn = state.turn;
    if (powerUp.type === "shield") player.shieldCharges = 1;
    else if (powerUp.type === "beam") player.hasBeam = true;
    state.stats.powerUpsCollected += 1;
    state.activeShotRecord?.pickups.push({
      powerUpId: powerUp.id,
      type: powerUp.type,
      ownerId: player.id,
      point: { x: powerUp.x, y: powerUp.y },
      // -1 means the exposed cache was reached by the centerline before this
      // shot's craters; otherwise replay it immediately after that crater.
      afterCraterIndex: (state.activeShotRecord.craters?.length ?? 0) - 1
    });
    const shield = powerUp.type === "shield";
    this.spawnBurst(powerUp.x, powerUp.y, shield ? "#a9d7e6" : "#f2c5a7", 34);
    this.showToast(
      `${player.name} won the ${shield ? "shield — one hit will be absorbed" : "beam — future curves now widen"}`,
      "success"
    );
    this.updateAllInterface();
    return true;
  }

  prepareShotScores(shooter, events) {
    const state = this.state;
    if (!state || !events.length) return;
    const targets = events
      .map((event) => state.players.find((player) => player.id === event.playerId))
      .filter((target) => target?.alive && !(target.shieldCharges > 0));
    const scoring = scoreMultiKill({ shooter, targets, terrain: state.field });
    const awardsByTarget = new Map(scoring.awards.map((award) => [award.targetId, award]));
    for (const event of events) event.scoreAward = awardsByTarget.get(event.playerId) ?? null;
  }

  applyHit(shooter, event) {
    const state = this.state;
    const target = state?.players.find((player) => player.id === event.playerId);
    if (!target?.alive || target.id === shooter.id) return;
    if (target.shieldCharges > 0) {
      target.shieldCharges -= 1;
      this.recordShotOutcome({
        type: "shield-block",
        targetId: target.id,
        point: { ...event.point },
        progress: event.progress
      });
      this.spawnBurst(target.x, target.y, "#a9d7e6", 30);
      this.showToast(`${target.name}'s shield absorbed ${shooter.name}'s hit`, "success");
      this.updateAllInterface();
      return;
    }
    const award = event.scoreAward ?? scoreMultiKill({
      shooter,
      targets: [target],
      terrain: state.field
    }).awards[0];
    target.alive = false;
    target.eliminatedThisTurn = true;
    shooter.kills += 1;
    shooter.scoreUnits += award?.pointUnits ?? 0;
    shooter.score = shooter.scoreUnits / 100;
    shooter.scoreHistory.push({
      turn: state.turn,
      targetId: target.id,
      targetName: target.name,
      straightDistance: award?.straightDistance ?? 0,
      obstacleDistance: award?.obstacleDistance ?? 0,
      baseValue: award?.value ?? 0,
      multiplier: award?.multiplier ?? 1,
      pointUnits: award?.pointUnits ?? 0,
      points: award?.points ?? 0
    });
    state.stats.totalEliminations += 1;
    state.stats.totalPointUnits += award?.pointUnits ?? 0;
    state.stats.totalPoints = state.stats.totalPointUnits / 100;
    this.recordShotOutcome({
      type: "elimination",
      targetId: target.id,
      point: { ...event.point },
      progress: event.progress,
      award: award ? {
        straightDistance: award.straightDistance,
        obstacleDistance: award.obstacleDistance,
        value: award.value,
        multiplier: award.multiplier,
        pointUnits: award.pointUnits,
        points: award.points
      } : null
    });
    this.spawnBurst(target.x, target.y, target.color, 26);
    const multiplier = award?.multiplier ?? 1;
    const bonus = multiplier > 1 ? ` · chain ×${multiplier}` : "";
    this.showToast(
      `${shooter.name} eliminated ${target.name} · +${formatPoints(award?.points ?? 0)} pts${bonus}`,
      target.isHuman ? "error" : "success"
    );
    this.updateAllInterface();
  }

  async endTurn(version) {
    const state = this.state;
    state.phase = "end-turn";
    state.currentShooterId = null;
    this.showBanner("End of turn — applying eliminations.", "quiet");
    this.updateAllInterface();
    await delay(this.reducedMotion ? 250 : 900);
    if (!this.isCurrent(version)) return;

    for (const player of state.players) {
      if (!player.alive) player.removed = true;
    }
    this.updateAllInterface();
    const survivors = state.players.filter((player) => player.alive);
    if (survivors.length < 2) {
      await delay(this.reducedMotion ? 150 : 550);
      if (this.isCurrent(version)) this.finishGame();
      return;
    }

    state.turn += 1;
    await delay(this.reducedMotion ? 180 : 650);
    if (this.isCurrent(version)) this.beginInputPhase(version);
  }

  finishGame() {
    const state = this.state;
    if (!state) return;
    state.phase = "ended";
    state.currentShooterId = null;
    clearInterval(this.timerInterval);
    this.dom.timer.textContent = "—";
    this.clearBanner();
    if (!state.replay.playing && !state.replay.finalSnapshot) {
      state.replay.finalSnapshot = this.captureReplaySnapshot();
    }
    const ranking = rankPlayers(state.players, state.turnOrder);
    const winner = ranking[0]?.player ?? null;
    const human = state.players.find((player) => player.isHuman);
    const humanStanding = ranking.find((entry) => entry.player.id === human?.id);
    const victory = humanStanding?.rank === 1;
    const tiedScore = Boolean(
      winner
      && ranking[1]
      && winner.scoreUnits === ranking[1].player.scoreUnits
    );

    this.dom.endCard.classList.toggle("defeat", !victory);
    this.dom.endEmblem.textContent = victory ? "✦" : "∿";
    this.dom.endKicker.textContent = "Final ranking";
    this.dom.endTitle.textContent = victory
      ? "Ranking victory!"
      : `${formatOrdinal(humanStanding?.rank ?? ranking.length)} place`;
    this.dom.endMessage.textContent = victory
      ? `You top the ranking with ${formatPoints(winner?.score ?? 0)} points.${tiedScore ? " The tie-break rules decided it." : ""}`
      : `${winner?.name ?? "No player"} wins with ${formatPoints(winner?.score ?? 0)} points. You scored ${formatPoints(human?.score ?? 0)}.${tiedScore ? " The tie was resolved by kills, survival, then fixed turn order." : ""}`;
    this.renderEndRanking(ranking);
    this.dom.endStats.replaceChildren();
    const stats = [
      [formatPoints(human?.score ?? 0), "Your points"],
      [human?.kills ?? 0, "Your kills"],
      [state.turn, "Turns"]
    ];
    for (const [value, label] of stats) {
      const item = document.createElement("div");
      item.className = "end-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      item.append(strong, span);
      this.dom.endStats.append(item);
    }
    this.dom.endOverlay.classList.remove("is-hidden");
    this.dom.replayButton.disabled = !state.replay.shots.length || state.replay.playing;
    this.updateAllInterface();
    requestAnimationFrame(() => this.dom.sameSettingsButton.focus());
  }

  renderEndRanking(ranking) {
    this.dom.endRanking.replaceChildren();
    for (const { player, rank } of ranking) {
      const item = document.createElement("li");
      item.className = "end-ranking-item";
      item.style.setProperty("--player-color", player.color);
      if (rank === 1) item.classList.add("is-winner");

      const place = document.createElement("strong");
      place.className = "end-rank-place";
      place.textContent = `#${rank}`;
      const dot = document.createElement("i");
      dot.className = "equation-color";
      const copy = document.createElement("span");
      copy.className = "end-rank-copy";
      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent = player.name;
      const detail = document.createElement("small");
      detail.textContent = `${player.kills} kill${player.kills === 1 ? "" : "s"} · ${player.alive ? "survived" : "eliminated"}`;
      copy.append(name, detail);
      const points = document.createElement("strong");
      points.className = "end-rank-score";
      points.textContent = `${formatPoints(player.score)} pts`;
      item.append(place, dot, copy, points);
      this.dom.endRanking.append(item);
    }
  }

  captureReplaySnapshot() {
    const state = this.state;
    if (!state) return null;
    return {
      terrainCells: state.field.cells.slice(),
      terrainRevision: state.field.revision,
      turn: state.turn,
      stats: { ...state.stats },
      players: state.players.map((player) => ({
        id: player.id,
        alive: player.alive,
        removed: player.removed,
        eliminatedThisTurn: player.eliminatedThisTurn,
        validated: player.validated,
        kills: player.kills,
        score: player.score,
        scoreUnits: player.scoreUnits,
        scoreHistory: player.scoreHistory.map((entry) => ({ ...entry })),
        shieldCharges: player.shieldCharges,
        hasBeam: player.hasBeam
      })),
      powerUps: clonePowerUps(state.powerUps),
      traces: state.traces.map((trace) => ({
        ...trace,
        paths: clonePaths(trace.paths)
      }))
    };
  }

  restoreReplaySnapshot(snapshot) {
    const state = this.state;
    if (!state || !snapshot) return;
    state.field.cells.set(snapshot.terrainCells);
    state.field.revision = snapshot.terrainRevision;
    state.field.rebuildVisual(document.documentElement.dataset.theme === "dark");
    for (const saved of snapshot.players) {
      const player = state.players.find((entry) => entry.id === saved.id);
      if (!player) continue;
      Object.assign(player, saved, {
        scoreHistory: saved.scoreHistory.map((entry) => ({ ...entry }))
      });
    }
    state.powerUps = clonePowerUps(snapshot.powerUps);
    state.stats = { ...snapshot.stats };
    state.turn = snapshot.turn;
    state.traces = snapshot.traces.map((trace) => ({
      ...trace,
      paths: clonePaths(trace.paths)
    }));
    state.preview = null;
    state.currentTrace = null;
    state.currentShooterId = null;
    state.activeShotRecord = null;
    state.particles = [];
  }

  async playReplay() {
    const state = this.state;
    if (!state || state.phase !== "ended" || state.replay.playing || !state.replay.shots.length) return;
    if (!state.replay.finalSnapshot) state.replay.finalSnapshot = this.captureReplaySnapshot();
    this.cancelRuntime();
    const version = this.runtimeVersion;
    state.replay.playing = true;
    this.dom.stopReplayButton.classList.remove("is-hidden");
    this.restoreReplaySnapshot(state.replay.initialSnapshot);
    state.phase = "replay";
    state.traces = [];
    this.resetReplayEquationReveal();
    this.dom.equationInput.disabled = true;
    this.dom.validateButton.disabled = true;
    this.dom.timer.textContent = "REPLAY";
    this.showBanner("Replay — reconstructing every official shot.", "quiet");
    this.updateAllInterface();
    await delay(this.reducedMotion ? 120 : 500);

    let replayTurn = null;
    for (const shot of state.replay.shots) {
      if (!this.isCurrent(version) || this.state !== state) return;
      if (replayTurn !== shot.turn) {
        if (replayTurn != null) {
          for (const player of state.players) {
            if (!player.alive) player.removed = true;
            player.eliminatedThisTurn = false;
          }
          state.traces = [];
        }
        replayTurn = shot.turn;
        state.turn = shot.turn;
        this.resetReplayEquationReveal();
      }
      const shooter = state.players.find((player) => player.id === shot.shooterId);
      if (!shooter) continue;
      state.currentShooterId = shooter.id;
      this.appendReplayEquation(shot);
      this.showBanner(`Replay · Turn ${shot.turn} · ${shot.shooterName}`, "active");
      this.updateAllInterface();
      await delay(this.reducedMotion ? 80 : 280);
      const completed = await this.animateReplayShot(shot, version);
      if (!completed || !this.isCurrent(version) || this.state !== state) return;

      state.traces.push({
        paths: clonePaths(shot.paths),
        color: shot.color,
        shooterId: shot.shooterId,
        beam: shot.beam
      });
      state.currentTrace = null;
      state.stats.shots += 1;
      if (shooter.isHuman) state.stats.humanShots += 1;
      await delay(this.reducedMotion ? 50 : 130);
      for (const pickup of shot.pickups.filter((entry) => entry.afterCraterIndex === -1)) {
        this.applyReplayPickup(pickup);
      }
      const appliedPickups = new Set(
        shot.pickups.filter((entry) => entry.afterCraterIndex === -1)
      );
      for (let craterIndex = 0; craterIndex < shot.craters.length; craterIndex += 1) {
        const crater = shot.craters[craterIndex];
        state.field.destroyCircle(crater.point.x, crater.point.y, crater.radius);
        state.stats.craters += 1;
        this.spawnBurst(crater.point.x, crater.point.y, "#f2c5a7", 12);
        for (const pickup of shot.pickups.filter((entry) => entry.afterCraterIndex === craterIndex)) {
          this.applyReplayPickup(pickup);
          appliedPickups.add(pickup);
        }
      }
      // Compatibility for records without timing metadata.
      for (const pickup of shot.pickups) {
        if (!appliedPickups.has(pickup)) this.applyReplayPickup(pickup);
      }
      this.updateAllInterface();
      await delay(this.reducedMotion ? 110 : 520);
    }

    if (!this.isCurrent(version) || this.state !== state) return;
    this.showBanner("Replay complete.", "quiet");
    await delay(this.reducedMotion ? 180 : 800);
    if (!this.isCurrent(version) || this.state !== state) return;
    this.restoreReplaySnapshot(state.replay.finalSnapshot);
    state.replay.playing = false;
    this.dom.stopReplayButton.classList.add("is-hidden");
    this.finishGame();
  }

  stopReplay() {
    const state = this.state;
    if (!state?.replay.playing) return;
    this.cancelRuntime();
    if (this.state !== state) return;
    this.restoreReplaySnapshot(state.replay.finalSnapshot);
    state.replay.playing = false;
    this.finishGame();
  }

  animateReplayShot(shot, version) {
    const state = this.state;
    const pointCount = shot.paths.reduce((sum, path) => sum + path.length, 0);
    const duration = this.reducedMotion ? 300 : clamp(850 + pointCount * 0.035, 950, 1650);
    const outcomes = shot.outcomes.map((outcome) => ({ ...outcome, handled: false }));
    state.currentTrace = {
      paths: shot.paths,
      impacts: shot.impacts,
      color: shot.color,
      progress: 0,
      shooterId: shot.shooterId,
      beam: shot.beam
    };
    return new Promise((resolve) => {
      const started = performance.now();
      const step = (now) => {
        if (!this.isCurrent(version) || this.state !== state) {
          resolve(false);
          return;
        }
        const progress = clamp((now - started) / duration, 0, 1);
        state.currentTrace.progress = progress;
        for (const outcome of outcomes) {
          if (outcome.handled || outcome.progress > progress + 0.01) continue;
          outcome.handled = true;
          this.applyReplayOutcome(shot.shooterId, outcome);
        }
        if (progress < 1) requestAnimationFrame(step);
        else {
          for (const outcome of outcomes.filter((entry) => !entry.handled)) {
            outcome.handled = true;
            this.applyReplayOutcome(shot.shooterId, outcome);
          }
          resolve(true);
        }
      };
      requestAnimationFrame(step);
    });
  }

  applyReplayOutcome(shooterId, outcome) {
    const state = this.state;
    const shooter = state.players.find((player) => player.id === shooterId);
    const target = state.players.find((player) => player.id === outcome.targetId);
    if (!shooter || !target) return;
    if (outcome.type === "shield-block") {
      target.shieldCharges = Math.max(0, target.shieldCharges - 1);
      this.spawnBurst(target.x, target.y, "#a9d7e6", 24);
      this.showToast(`${target.name}'s shield absorbed the replayed hit`, "success");
      this.updateAllInterface();
      return;
    }
    if (outcome.type !== "elimination" || !target.alive) return;
    const award = outcome.award ?? { pointUnits: 0, points: 0, multiplier: 1 };
    target.alive = false;
    target.eliminatedThisTurn = true;
    shooter.kills += 1;
    shooter.scoreUnits += award.pointUnits ?? 0;
    shooter.score = shooter.scoreUnits / 100;
    shooter.scoreHistory.push({
      turn: state.turn,
      targetId: target.id,
      targetName: target.name,
      straightDistance: award.straightDistance ?? 0,
      obstacleDistance: award.obstacleDistance ?? 0,
      baseValue: award.value ?? 0,
      multiplier: award.multiplier ?? 1,
      pointUnits: award.pointUnits ?? 0,
      points: award.points ?? 0
    });
    state.stats.totalEliminations += 1;
    state.stats.totalPointUnits += award.pointUnits ?? 0;
    state.stats.totalPoints = state.stats.totalPointUnits / 100;
    this.spawnBurst(target.x, target.y, target.color, 22);
    this.updateAllInterface();
  }

  applyReplayPickup(pickup) {
    const state = this.state;
    const powerUp = state.powerUps.find((entry) => entry.id === pickup.powerUpId);
    const owner = state.players.find((player) => player.id === pickup.ownerId);
    if (!powerUp || !owner || powerUp.collected) return;
    powerUp.exposed = true;
    powerUp.collected = true;
    powerUp.ownerId = owner.id;
    if (pickup.type === "shield") owner.shieldCharges = 1;
    else if (pickup.type === "beam") owner.hasBeam = true;
    state.stats.powerUpsCollected += 1;
    this.spawnBurst(pickup.point.x, pickup.point.y, pickup.type === "shield" ? "#a9d7e6" : "#f2c5a7", 26);
  }

  updateAllInterface() {
    if (!this.state) return;
    this.updatePhaseHeader();
    this.updateRoster();
    this.updateTurnOrder();
    this.updateSubmissionCount();
  }

  updatePhaseHeader() {
    const state = this.state;
    const labels = {
      input: "Input phase",
      reveal: "Curves revealed",
      simulation: "Simulation",
      replay: "Replay",
      "end-turn": "End of turn",
      ended: "Game complete",
      setup: "Preparing arena"
    };
    this.dom.phaseLabel.textContent = labels[state.phase] ?? "Preparing";
    this.dom.turnNumber.textContent = String(state.turn);
    const alive = state.players.filter((player) => player.alive).length;
    this.dom.aliveCount.textContent = String(alive);
  }

  updateTimer() {
    if (!this.state) return;
    this.dom.timer.textContent = formatClock(this.state.remainingSeconds);
    this.dom.timer.classList.toggle("warning", this.state.remainingSeconds <= 30);
  }

  updateSubmissionCount() {
    if (!this.state) return;
    if (this.state.phase === "replay") {
      this.dom.submissionCount.textContent = "Replay";
      return;
    }
    const active = this.state.players.filter((player) => !player.removed);
    const locked = active.filter((player) => player.validated).length;
    this.dom.submissionCount.textContent = `${locked}/${active.length}`;
  }

  resetReplayEquationReveal() {
    this.dom.equationReveal.replaceChildren();
    const list = document.createElement("ol");
    list.className = "equation-list replay-equation-list";
    this.dom.equationReveal.append(list);
  }

  appendReplayEquation(shot) {
    let list = $(".replay-equation-list", this.dom.equationReveal);
    if (!list) {
      this.resetReplayEquationReveal();
      list = $(".replay-equation-list", this.dom.equationReveal);
    }
    const item = document.createElement("li");
    item.className = "equation-item";
    item.style.setProperty("--player-color", shot.color);
    const header = document.createElement("div");
    header.className = "equation-item-header";
    const color = document.createElement("i");
    color.className = "equation-color";
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = `${shot.shooterName} · Turn ${shot.turn}`;
    header.append(color, name);
    const equation = document.createElement("div");
    equation.className = "equation-latex";
    try {
      this.renderLatex(equation, equationToLatex(parseEquation(shot.equation, window.math), window.math));
    } catch {
      equation.textContent = shot.equation || "∅  Null shot";
    }
    item.append(header, equation);
    list.append(item);
  }

  updateRoster() {
    const state = this.state;
    this.dom.playerList.replaceChildren();
    for (const { player, rank } of rankPlayers(state.players, state.turnOrder)) {
      const item = document.createElement("li");
      item.className = "player-item";
      item.style.setProperty("--player-color", player.color);
      item.classList.toggle("is-current", state.currentShooterId === player.id);
      item.classList.toggle("is-eliminated", !player.alive);

      const place = document.createElement("span");
      place.className = "player-rank";
      place.textContent = `#${rank}`;
      const avatar = document.createElement("span");
      avatar.className = "player-avatar";
      avatar.textContent = initials(player.name);
      const copy = document.createElement("span");
      copy.className = "player-copy";
      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent = player.name;
      const meta = document.createElement("span");
      meta.className = "player-meta";
      let statusText;
      if (!player.alive) statusText = "Eliminated";
      else if (state.currentShooterId === player.id) statusText = "Tracing now";
      else if (state.phase === "input" && player.validated) statusText = "Equation locked";
      else statusText = player.isHuman ? "Human player" : "Bot player";
      meta.textContent = `${statusText} · ${player.kills} kill${player.kills === 1 ? "" : "s"}`;
      copy.append(name, meta);
      if (player.shieldCharges > 0 || player.hasBeam) {
        const inventory = document.createElement("span");
        inventory.className = "player-inventory";
        if (player.shieldCharges > 0) {
          const shield = document.createElement("i");
          shield.className = "powerup-badge shield";
          shield.textContent = "◆ Shield";
          shield.title = "Blocks the next hit";
          inventory.append(shield);
        }
        if (player.hasBeam) {
          const beam = document.createElement("i");
          beam.className = "powerup-badge beam";
          beam.textContent = "➤ Beam";
          beam.title = "Curves widen with distance";
          inventory.append(beam);
        }
        copy.append(inventory);
      }

      const status = document.createElement("span");
      status.className = "player-score";
      const score = document.createElement("strong");
      score.textContent = formatPoints(player.score);
      const label = document.createElement("small");
      label.textContent = "pts";
      status.append(score, label);
      item.append(place, avatar, copy, status);
      this.dom.playerList.append(item);
    }
  }

  updateTurnOrder() {
    const state = this.state;
    const human = state.players.find((player) => player.isHuman);
    this.dom.turnOrder.replaceChildren();
    for (const playerId of state.turnOrder) {
      const player = state.players.find((entry) => entry.id === playerId);
      const item = document.createElement("li");
      item.className = "turn-item";
      item.style.setProperty("--player-color", player.color);
      item.classList.toggle("is-current", state.currentShooterId === player.id);
      item.classList.toggle("is-eliminated", !player.alive);
      const dot = document.createElement("i");
      dot.className = "equation-color";
      const copy = document.createElement("span");
      copy.className = "turn-player-copy";
      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent = player.name;
      const coordinates = document.createElement("small");
      coordinates.className = "player-coordinates";
      const localX = Math.round(player.x - (human?.x ?? 0));
      const localY = Math.round((human?.y ?? state.height) - player.y);
      coordinates.textContent = `x ${formatSignedCoordinate(localX)} · y ${formatSignedCoordinate(localY)}`;
      coordinates.title = "Coordinates relative to you; positive y points upward";
      copy.append(name, coordinates);
      const stateText = document.createElement("small");
      stateText.className = "order-state";
      stateText.textContent = !player.alive ? "out" : state.currentShooterId === player.id ? "now" : "";
      item.append(dot, copy, stateText);
      this.dom.turnOrder.append(item);
    }
  }

  showBanner(message, tone = "quiet", hold = 0) {
    clearTimeout(this.bannerTimer);
    this.dom.stageBanner.textContent = message;
    this.dom.stageBanner.className = `stage-banner tone-${tone}`;
    if (hold > 0) this.bannerTimer = setTimeout(() => this.clearBanner(), hold);
  }

  clearBanner() {
    clearTimeout(this.bannerTimer);
    this.dom.stageBanner.classList.add("is-hidden");
  }

  showToast(message, tone = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`;
    const icon = document.createElement("span");
    icon.textContent = tone === "error" ? "×" : "✦";
    const copy = document.createElement("span");
    copy.textContent = message;
    toast.append(icon, copy);
    this.dom.toastStack.append(toast);
    setTimeout(() => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 260);
    }, this.reducedMotion ? 1100 : 2600);
  }

  renderLatex(container, latex) {
    container.replaceChildren();
    try {
      window.katex.render(latex, container, {
        throwOnError: false,
        strict: false,
        trust: false,
        output: "html"
      });
    } catch {
      container.textContent = latex;
    }
  }

  setLatexPlaceholder(message) {
    this.dom.latexPreview.replaceChildren();
    const placeholder = document.createElement("span");
    placeholder.className = "preview-placeholder";
    placeholder.textContent = message;
    this.dom.latexPreview.append(placeholder);
  }

  fitCanvas() {
    if (!this.state || this.dom.gameScreen.classList.contains("is-hidden")) return;
    const availableWidth = Math.max(240, this.dom.canvasWrap.clientWidth - 28);
    const availableHeight = Math.max(180, this.dom.canvasWrap.clientHeight - 28);
    const scale = Math.min(1, availableWidth / this.state.width, availableHeight / this.state.height);
    this.dom.canvas.style.width = `${Math.floor(this.state.width * scale)}px`;
    this.dom.canvas.style.height = `${Math.floor(this.state.height * scale)}px`;
  }

  renderLoop(time) {
    const delta = Math.min(0.05, (time - this.lastFrameTime) / 1000);
    this.lastFrameTime = time;
    if (this.state && !this.dom.gameScreen.classList.contains("is-hidden")) this.drawWorld(time, delta);
    requestAnimationFrame((next) => this.renderLoop(next));
  }

  drawWorld(time) {
    const state = this.state;
    const context = this.context;
    const dark = document.documentElement.dataset.theme === "dark";
    context.clearRect(0, 0, state.width, state.height);
    context.fillStyle = dark ? "#29293a" : "#f8f4f0";
    context.fillRect(0, 0, state.width, state.height);
    this.drawMapGrid(context, dark);

    // Completed traces sit beneath intact terrain, while the active and
    // preview curves are clipped already and stay visible right up to impact.
    for (const trace of state.traces) {
      this.drawCurve(context, trace.paths, trace.color, 1, false, 0.66, trace.beam);
    }
    if (state.preview?.beam && state.phase === "input") {
      this.drawBeamEnvelope(context, state.preview.paths, state.preview.color, 1, true, 0.62);
    }
    if (state.currentTrace?.beam) {
      this.drawBeamEnvelope(
        context,
        state.currentTrace.paths,
        state.currentTrace.color,
        state.currentTrace.progress,
        false,
        1
      );
    }
    state.field.draw(context);
    this.drawPowerUps(context, time);

    if (state.preview && state.phase === "input") {
      this.drawCurve(context, state.preview.paths, state.preview.color, 1, true, 0.62, false);
      this.drawImpactMarkers(context, state.preview, 1, true);
    }
    if (state.currentTrace) {
      this.drawCurve(
        context,
        state.currentTrace.paths,
        state.currentTrace.color,
        state.currentTrace.progress,
        false,
        1,
        false
      );
      this.drawImpactMarkers(context, state.currentTrace, state.currentTrace.progress, false);
    }

    this.drawPlayers(context, time);
    this.drawParticles(context, time);
    context.save();
    context.strokeStyle = dark ? "rgba(210,205,224,.24)" : "rgba(75,68,82,.16)";
    context.lineWidth = 2;
    context.strokeRect(1, 1, state.width - 2, state.height - 2);
    context.restore();
  }

  drawMapGrid(context, dark) {
    const state = this.state;
    context.save();
    context.beginPath();
    for (let x = 40; x < state.width; x += 40) {
      context.moveTo(x, 0);
      context.lineTo(x, state.height);
    }
    for (let y = 40; y < state.height; y += 40) {
      context.moveTo(0, y);
      context.lineTo(state.width, y);
    }
    context.strokeStyle = dark ? "rgba(225,218,238,.035)" : "rgba(88,78,94,.045)";
    context.lineWidth = 1;
    context.stroke();
    context.restore();
  }

  drawCurve(context, paths, color, progress = 1, preview = false, opacity = 1, beam = false) {
    if (beam) this.drawBeamEnvelope(context, paths, color, progress, preview, opacity);
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = preview ? 3 : 4.4;
    context.strokeStyle = color;
    context.globalAlpha = opacity;
    context.shadowColor = color;
    context.shadowBlur = preview ? 5 : 9;
    if (preview) context.setLineDash([11, 8]);

    for (const path of paths ?? []) {
      if (path.length < 2 || progress <= 0) continue;
      const lastPosition = (path.length - 1) * clamp(progress, 0, 1);
      const lastWhole = Math.floor(lastPosition);
      context.beginPath();
      context.moveTo(path[0].x, path[0].y);
      for (let index = 1; index <= lastWhole; index += 1) context.lineTo(path[index].x, path[index].y);
      if (lastWhole < path.length - 1) {
        const amount = lastPosition - lastWhole;
        const from = path[lastWhole];
        const to = path[lastWhole + 1];
        context.lineTo(from.x + (to.x - from.x) * amount, from.y + (to.y - from.y) * amount);
      }
      context.stroke();
    }
    context.restore();
  }

  drawBeamEnvelope(context, paths, color, progress = 1, preview = false, opacity = 1) {
    context.save();
    context.fillStyle = color;
    context.globalAlpha = opacity * (preview ? 0.13 : 0.2);
    context.shadowColor = color;
    context.shadowBlur = preview ? 7 : 13;

    for (const path of paths ?? []) {
      if (path.length < 2 || progress <= 0) continue;
      const lastPosition = (path.length - 1) * clamp(progress, 0, 1);
      const lastWhole = Math.floor(lastPosition);
      const cumulative = new Float64Array(lastWhole + 2);
      for (let index = 1; index <= lastWhole + 1 && index < path.length; index += 1) {
        cumulative[index] = cumulative[index - 1]
          + Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
      }
      const visible = [{ point: path[0], distance: 0 }];
      for (let index = 1; index <= lastWhole; index += 1) {
        visible.push({ point: path[index], distance: cumulative[index] });
      }
      if (lastWhole > 0 && visible[visible.length - 1].point !== path[lastWhole]) {
        visible.push({ point: path[lastWhole], distance: cumulative[lastWhole] });
      }
      if (lastWhole < path.length - 1) {
        const amount = lastPosition - lastWhole;
        const from = path[lastWhole];
        const to = path[lastWhole + 1];
        const partialLength = Math.hypot(to.x - from.x, to.y - from.y) * amount;
        visible.push({
          point: { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount },
          distance: cumulative[lastWhole] + partialLength
        });
      }

      for (let index = 0; index < visible.length - 1; index += 1) {
        const first = visible[index];
        const second = visible[index + 1];
        const dx = second.point.x - first.point.x;
        const dy = second.point.y - first.point.y;
        const length = Math.hypot(dx, dy);
        if (!(length > 1e-6)) continue;
        const nx = -dy / length;
        const ny = dx / length;
        const firstRadius = beamRadiusAtDistance(first.distance);
        const secondRadius = beamRadiusAtDistance(second.distance);
        context.beginPath();
        context.moveTo(first.point.x + nx * firstRadius, first.point.y + ny * firstRadius);
        context.lineTo(second.point.x + nx * secondRadius, second.point.y + ny * secondRadius);
        context.lineTo(second.point.x - nx * secondRadius, second.point.y - ny * secondRadius);
        context.lineTo(first.point.x - nx * firstRadius, first.point.y - ny * firstRadius);
        context.closePath();
        context.fill();
        if (index > 0) {
          context.beginPath();
          context.arc(first.point.x, first.point.y, firstRadius, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
    context.restore();
  }

  drawPowerUps(context, time) {
    const pulse = (Math.sin(time / 260) + 1) / 2;
    for (const powerUp of this.state.powerUps ?? []) {
      if (powerUp.collected) continue;
      const shield = powerUp.type === "shield";
      const color = shield ? "#8ccfe4" : "#f0ae78";
      context.save();
      context.translate(powerUp.x, powerUp.y);
      context.globalAlpha = powerUp.exposed ? 1 : 0.78;
      context.shadowColor = color;
      context.shadowBlur = 12 + pulse * 9;
      context.fillStyle = withAlpha(color, powerUp.exposed ? 0.9 : 0.72);
      context.strokeStyle = "rgba(255,255,255,.9)";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(0, 0, 10 + pulse * 1.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.shadowBlur = 0;
      context.fillStyle = "#383240";
      context.font = "900 13px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(shield ? "◆" : "➤", 0, 0.5);
      if (!powerUp.exposed) {
        context.strokeStyle = withAlpha(color, 0.78);
        context.lineWidth = 1.5;
        context.setLineDash([3, 3]);
        context.beginPath();
        context.arc(0, 0, 15 + pulse * 2, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
    }
  }

  drawImpactMarkers(context, trace, progress = 1, preview = false) {
    if (progress < 0.985) return;
    const impacts = trace?.impacts?.filter((impact) => impact.type === "terrain") ?? [];
    if (!impacts.length) return;

    context.save();
    context.globalAlpha = preview ? 0.72 : 0.96;
    context.lineWidth = preview ? 1.5 : 2;
    context.strokeStyle = trace.color;
    context.fillStyle = document.documentElement.dataset.theme === "dark" ? "#2b2b3b" : "#faf8f5";
    context.shadowColor = trace.color;
    context.shadowBlur = preview ? 4 : 9;
    if (preview) context.setLineDash([3, 3]);

    for (const impact of impacts) {
      const branch = trace.paths?.[impact.branchIndex];
      const point = branch?.[branch.length - 1] ?? impact.point;
      if (!point) continue;
      context.beginPath();
      context.arc(point.x, point.y, preview ? 4.5 : 5.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  drawPlayers(context, time) {
    const state = this.state;
    const previewHits = new Set(state.preview?.hitIds ?? []);
    const pulse = (Math.sin(time / 150) + 1) / 2;
    for (const player of state.players) {
      if (player.removed && !player.eliminatedThisTurn) continue;
      const highlighted = previewHits.has(player.id);
      context.save();
      context.globalAlpha = player.alive ? 1 : 0.38;

      context.beginPath();
      context.arc(player.x, player.y, player.hitRadius + (highlighted ? 4 + pulse * 5 : 0), 0, Math.PI * 2);
      context.strokeStyle = highlighted ? player.color : withAlpha(player.color, 0.35);
      context.lineWidth = highlighted ? 4 : 1.5;
      context.setLineDash(highlighted ? [] : [5, 5]);
      context.stroke();

      if (player.isHuman && player.alive) this.drawLocalAxes(context, player);

      context.setLineDash([]);
      context.shadowColor = withAlpha(player.color, 0.72);
      context.shadowBlur = highlighted ? 18 : 9;
      context.beginPath();
      context.arc(player.x, player.y, player.bodyRadius + 3, 0, Math.PI * 2);
      context.fillStyle = withAlpha(player.color, 0.32);
      context.fill();
      context.beginPath();
      context.arc(player.x, player.y, player.bodyRadius, 0, Math.PI * 2);
      context.fillStyle = player.color;
      context.fill();
      context.strokeStyle = "rgba(255,255,255,.78)";
      context.lineWidth = 3;
      context.stroke();
      context.shadowBlur = 0;
      context.fillStyle = "#37313d";
      context.font = "800 11px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(initials(player.name), player.x, player.y + 0.5);

      if (player.alive) this.drawOwnedPowerUps(context, player, time);

      if (!player.alive) {
        context.strokeStyle = "#cf667c";
        context.lineWidth = 4;
        context.beginPath();
        context.moveTo(player.x - 10, player.y - 10);
        context.lineTo(player.x + 10, player.y + 10);
        context.moveTo(player.x + 10, player.y - 10);
        context.lineTo(player.x - 10, player.y + 10);
        context.stroke();
      }

      this.drawPlayerLabel(context, player, highlighted);
      context.restore();
    }
  }

  drawLocalAxes(context, player) {
    context.save();
    context.strokeStyle = withAlpha(player.color, 0.42);
    context.lineWidth = 1;
    context.setLineDash([3, 4]);
    context.beginPath();
    context.moveTo(player.x - 34, player.y);
    context.lineTo(player.x + 34, player.y);
    context.moveTo(player.x, player.y - 34);
    context.lineTo(player.x, player.y + 34);
    context.stroke();
    context.restore();
  }

  drawOwnedPowerUps(context, player, time) {
    const pulse = (Math.sin(time / 220) + 1) / 2;
    if (player.shieldCharges > 0) {
      context.save();
      context.strokeStyle = withAlpha("#8ccfe4", 0.72 + pulse * 0.2);
      context.lineWidth = 2.5;
      context.shadowColor = "#8ccfe4";
      context.shadowBlur = 9 + pulse * 5;
      context.beginPath();
      context.arc(player.x, player.y, player.bodyRadius + 8 + pulse * 1.2, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
    if (player.hasBeam) {
      context.save();
      const x = player.x + player.bodyRadius + 8;
      const y = player.y - player.bodyRadius - 7;
      context.fillStyle = "#f0ae78";
      context.strokeStyle = "rgba(255,255,255,.88)";
      context.lineWidth = 1.5;
      context.shadowColor = "#f0ae78";
      context.shadowBlur = 8;
      context.beginPath();
      context.moveTo(x + 6, y);
      context.lineTo(x - 5, y - 5);
      context.lineTo(x - 2, y + 6);
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
    }
  }

  drawPlayerLabel(context, player, highlighted) {
    context.save();
    context.font = "700 12px system-ui, sans-serif";
    const width = context.measureText(player.name).width + 18;
    const x = clamp(player.x - width / 2, 4, this.state.width - width - 4);
    const y = clamp(player.y - player.hitRadius - 28, 4, this.state.height - 25);
    roundedRect(context, x, y, width, 21, 8);
    context.fillStyle = highlighted ? withAlpha(player.color, 0.95) : "rgba(42,38,48,.82)";
    context.fill();
    context.fillStyle = highlighted ? "#342f39" : "#fffdfb";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(player.name, x + width / 2, y + 10.5);
    context.restore();
  }

  spawnBurst(x, y, color, count = 16) {
    if (!this.state) return;
    const now = performance.now();
    for (let index = 0; index < count; index += 1) {
      this.state.particles.push({
        x,
        y,
        color,
        angle: (Math.PI * 2 * index) / count + Math.random() * 0.35,
        speed: 22 + Math.random() * 60,
        radius: 2 + Math.random() * 4,
        start: now,
        life: 520 + Math.random() * 420
      });
    }
  }

  drawParticles(context, time) {
    const particles = this.state.particles;
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const particle = particles[index];
      const age = time - particle.start;
      if (age >= particle.life) {
        particles.splice(index, 1);
        continue;
      }
      const progress = age / particle.life;
      const travel = particle.speed * (age / 1000) * (1 - progress * 0.35);
      context.save();
      context.globalAlpha = (1 - progress) ** 1.6;
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(
        particle.x + Math.cos(particle.angle) * travel,
        particle.y + Math.sin(particle.angle) * travel,
        particle.radius * (1 - progress * 0.45),
        0,
        Math.PI * 2
      );
      context.fill();
      context.restore();
    }
  }

  isCurrent(version) {
    return version === this.runtimeVersion;
  }
}

function friendlyEquationError(error) {
  if (!error) return "This equation could not be interpreted.";
  return String(error.message || error).replace(/^Could not understand this equation:\s*/i, "");
}

function shortEquationLabel(parsed) {
  if (!parsed) return "a null curve";
  return "an f(x) function";
}

function formatSignedCoordinate(value) {
  const rounded = Math.round(Number(value) || 0);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function formatPoints(value) {
  return SCORE_FORMATTER.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function formatOrdinal(value) {
  const integer = Math.max(1, Math.floor(Number(value) || 1));
  const lastTwo = integer % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13
    ? "th"
    : integer % 10 === 1
      ? "st"
      : integer % 10 === 2
        ? "nd"
        : integer % 10 === 3
          ? "rd"
          : "th";
  return `${integer}${suffix}`;
}

function initials(name) {
  if (name === "You") return "Y";
  return String(name).split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function clonePaths(paths) {
  return (paths ?? []).map((path) => path.map((point) => ({ x: point.x, y: point.y })));
}

function clonePowerUps(powerUps) {
  return (powerUps ?? []).map((powerUp) => ({
    ...powerUp,
    position: powerUp.position ? { ...powerUp.position } : { x: powerUp.x, y: powerUp.y },
    breachShotIds: [...(powerUp.breachShotIds ?? [])]
  }));
}

function distanceToPaths(paths, point) {
  if (!point || !paths?.length) return Infinity;
  let minimum = Infinity;
  for (const path of paths) {
    for (let index = 0; index < path.length - 1; index += 1) {
      minimum = Math.min(minimum, pointSegmentDistance(path[index], path[index + 1], point));
    }
  }
  return minimum;
}

function pointSegmentDistance(start, end, point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared === 0
    ? 0
    : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount));
}

function roundedRect(context, x, y, width, height, radius) {
  if (typeof context.roundRect === "function") {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function withAlpha(hex, alpha) {
  const normalized = String(hex).replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((character) => character + character).join("")
    : normalized;
  const number = Number.parseInt(value, 16);
  if (!Number.isFinite(number)) return `rgba(191,180,229,${alpha})`;
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

new CurveClashGame();
