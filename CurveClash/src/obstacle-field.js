/**
 * Mutable, low-resolution pixel field used as the authoritative obstacle map.
 * Every filled cell is solid. Craters clear cells immediately, so subsequent
 * equation traces can travel through the opening.
 */
export class ObstacleField {
  constructor(width, height, cellSize = 4) {
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.columns = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.cells = new Uint8Array(this.columns * this.rows);
    this.revision = 0;

    this.visual = document.createElement("canvas");
    this.visual.width = this.columns;
    this.visual.height = this.rows;
    this.visualContext = this.visual.getContext("2d", { alpha: true });
    this.dark = false;
  }

  index(column, row) {
    return row * this.columns + column;
  }

  inBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  isSolid(x, y) {
    if (!this.inBounds(x, y)) return false;
    const column = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    return this.cells[this.index(column, row)] === 1;
  }

  // Equation-engine terrain adapter.
  isBlocked(x, y) {
    return this.isSolid(x, y);
  }

  isCellSolid(column, row) {
    if (column < 0 || row < 0 || column >= this.columns || row >= this.rows) return false;
    return this.cells[this.index(column, row)] === 1;
  }

  clear() {
    this.cells.fill(0);
    this.revision += 1;
  }

  fillRoundedRect(x, y, width, height, radius = 12) {
    const left = Math.max(0, Math.floor(x / this.cellSize));
    const top = Math.max(0, Math.floor(y / this.cellSize));
    const right = Math.min(this.columns - 1, Math.ceil((x + width) / this.cellSize));
    const bottom = Math.min(this.rows - 1, Math.ceil((y + height) / this.cellSize));
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const innerLeft = x + r;
    const innerRight = x + width - r;
    const innerTop = y + r;
    const innerBottom = y + height - r;

    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const px = (column + 0.5) * this.cellSize;
        const py = (row + 0.5) * this.cellSize;
        const nearestX = Math.max(innerLeft, Math.min(innerRight, px));
        const nearestY = Math.max(innerTop, Math.min(innerBottom, py));
        if ((px - nearestX) ** 2 + (py - nearestY) ** 2 <= r ** 2) {
          this.cells[this.index(column, row)] = 1;
        }
      }
    }
  }

  fillEllipse(centerX, centerY, radiusX, radiusY) {
    const left = Math.max(0, Math.floor((centerX - radiusX) / this.cellSize));
    const top = Math.max(0, Math.floor((centerY - radiusY) / this.cellSize));
    const right = Math.min(this.columns - 1, Math.ceil((centerX + radiusX) / this.cellSize));
    const bottom = Math.min(this.rows - 1, Math.ceil((centerY + radiusY) / this.cellSize));

    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const px = ((column + 0.5) * this.cellSize - centerX) / radiusX;
        const py = ((row + 0.5) * this.cellSize - centerY) / radiusY;
        if (px * px + py * py <= 1) this.cells[this.index(column, row)] = 1;
      }
    }
  }

  generate(density = "medium", random = Math.random) {
    this.clear();
    const areaScale = (this.width * this.height) / (1200 * 720);
    const baseCounts = { low: 10, medium: 16, high: 23 };
    const count = Math.max(7, Math.round((baseCounts[density] ?? baseCounts.medium) * Math.sqrt(areaScale)));
    const margin = Math.max(34, Math.round(Math.min(this.width, this.height) * 0.045));

    for (let obstacle = 0; obstacle < count; obstacle += 1) {
      const maxWidth = Math.min(190, this.width * 0.17);
      const maxHeight = Math.min(125, this.height * 0.18);
      const width = randomBetween(62, maxWidth, random);
      const height = randomBetween(44, maxHeight, random);
      const x = randomBetween(margin, Math.max(margin, this.width - width - margin), random);
      const y = randomBetween(margin, Math.max(margin, this.height - height - margin), random);

      if (random() < 0.22) {
        this.fillEllipse(x + width / 2, y + height / 2, width / 2, height / 2);
      } else {
        this.fillRoundedRect(x, y, width, height, randomBetween(8, 24, random));
      }
    }

    this.revision += 1;
    this.rebuildVisual(this.dark);
  }

  isCircleClear(x, y, radius, padding = 0) {
    if (x - radius - padding < 0 || y - radius - padding < 0) return false;
    if (x + radius + padding >= this.width || y + radius + padding >= this.height) return false;

    const checkRadius = radius + padding;
    const left = Math.floor((x - checkRadius) / this.cellSize);
    const top = Math.floor((y - checkRadius) / this.cellSize);
    const right = Math.ceil((x + checkRadius) / this.cellSize);
    const bottom = Math.ceil((y + checkRadius) / this.cellSize);
    const radiusSquared = checkRadius ** 2;

    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        if (!this.isCellSolid(column, row)) continue;
        const px = (column + 0.5) * this.cellSize;
        const py = (row + 0.5) * this.cellSize;
        if ((px - x) ** 2 + (py - y) ** 2 <= radiusSquared) return false;
      }
    }
    return true;
  }

  randomClearPosition(radius = 26, avoid = [], random = Math.random) {
    const separation = Math.max(76, radius * 2.7);
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      const x = randomBetween(radius + 18, this.width - radius - 18, random);
      const y = randomBetween(radius + 18, this.height - radius - 18, random);
      if (!this.isCircleClear(x, y, radius, 14)) continue;
      if (avoid.some((point) => Math.hypot(point.x - x, point.y - y) < separation)) continue;
      return { x, y };
    }

    // Dense random maps should still always be playable. The fallback creates a
    // small spawn pocket at a deterministic scan position rather than failing.
    for (let y = radius + 24; y < this.height - radius - 24; y += radius * 2 + 24) {
      for (let x = radius + 24; x < this.width - radius - 24; x += radius * 2 + 24) {
        if (avoid.some((point) => Math.hypot(point.x - x, point.y - y) < separation)) continue;
        this.destroyCircle(x, y, radius + 18, false);
        return { x, y };
      }
    }

    return { x: this.width / 2, y: this.height / 2 };
  }

  destroyCircle(x, y, radius = 16, rebuild = true) {
    const left = Math.max(0, Math.floor((x - radius) / this.cellSize));
    const top = Math.max(0, Math.floor((y - radius) / this.cellSize));
    const right = Math.min(this.columns - 1, Math.ceil((x + radius) / this.cellSize));
    const bottom = Math.min(this.rows - 1, Math.ceil((y + radius) / this.cellSize));
    const radiusSquared = radius ** 2;
    let cleared = 0;

    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const px = (column + 0.5) * this.cellSize;
        const py = (row + 0.5) * this.cellSize;
        if ((px - x) ** 2 + (py - y) ** 2 > radiusSquared) continue;
        const cellIndex = this.index(column, row);
        if (this.cells[cellIndex]) {
          this.cells[cellIndex] = 0;
          cleared += 1;
        }
      }
    }

    if (cleared > 0) {
      this.revision += 1;
      if (rebuild) this.rebuildVisual(this.dark);
    }
    return cleared;
  }

  // Equation-engine terrain adapter. Keeping this small interface separate
  // makes the sampler testable with any other tile or pixel implementation.
  carveCircle(x, y, radius = 16) {
    const removed = this.destroyCircle(x, y, radius, true);
    return { removed, revision: this.revision };
  }

  rebuildVisual(dark = false) {
    this.dark = dark;
    const context = this.visualContext;
    const image = context.createImageData(this.columns, this.rows);
    const fill = dark ? [79, 80, 102, 255] : [207, 207, 211, 255];
    const edge = dark ? [112, 113, 143, 255] : [177, 177, 185, 255];

    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        if (!this.isCellSolid(column, row)) continue;
        const isEdge =
          !this.isCellSolid(column - 1, row) ||
          !this.isCellSolid(column + 1, row) ||
          !this.isCellSolid(column, row - 1) ||
          !this.isCellSolid(column, row + 1);
        const color = isEdge ? edge : fill;
        const pixelIndex = this.index(column, row) * 4;
        image.data[pixelIndex] = color[0];
        image.data[pixelIndex + 1] = color[1];
        image.data[pixelIndex + 2] = color[2];
        image.data[pixelIndex + 3] = color[3];
      }
    }
    context.clearRect(0, 0, this.columns, this.rows);
    context.putImageData(image, 0, 0);
  }

  draw(context) {
    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(this.visual, 0, 0, this.columns, this.rows, 0, 0, this.width, this.height);
    context.restore();
  }
}

function randomBetween(min, max, random = Math.random) {
  return min + (max - min) * random();
}
