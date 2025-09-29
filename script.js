/* script.js - Code Craft (complete) */
/* Pastikan RECIPES_DATA & PUZZLES_DATA disediakan dalam HTML (kau dah sediakan) */
/* GSAP sudah dimuatkan di HTML */

/* ===========================
   Helper & Constants
   =========================== */
const SAVE_KEY = 'codecraft-save-v1';
const THEME_KEY = 'codecraft-theme-v1';

class CodeCraftGame {
  constructor() {
    // Game state
    this.currentLevel = 1;
    this.score = 0;
    this.inventory = [];
    this.maxLevel = 3;
    this.achievements = [];
    // timers / settings
    this.hintTimer = null;
    this.hintTimeout = 120000; // 2min
    this._autosaveInterval = 10000;
    this._debounceSaveHandle = null;
    this._consoleCount = 0;
    this._consoleLimit = 300;
    this._workerTimeout = 3000; // ms
    // internal
    this._debounceHandle = null;
    this._autosaveHandle = null;

    // init
    document.addEventListener('DOMContentLoaded', () => this.init());
  }

  init() {
    try {
      this.bindEvents();
      this.loadGameState();
      this.updateDisplay();
      this.loadCurrentLevel();
      this.startHintTimer();
      this._autosaveHandle = setInterval(() => this.saveGameState(), this._autosaveInterval);
    } catch (err) {
      this._handleError(err, 'init');
    }
  }

  /* ===========================
     Events & UI bindings
     =========================== */
  bindEvents() {
    try {
      const themeToggle = document.getElementById('themeToggle');
      if (themeToggle) themeToggle.addEventListener('click', () => this.toggleTheme());

      const craftBtn = document.getElementById('craftBtn');
      if (craftBtn) craftBtn.addEventListener('click', (e) => { e.preventDefault(); this.craftItem(); });

      const clearBtn = document.getElementById('clearBtn');
      if (clearBtn) clearBtn.addEventListener('click', () => this.clearCode());

      const hintBtn = document.getElementById('hintBtn');
      if (hintBtn) hintBtn.addEventListener('click', () => this.showHint());

      const resetPuzzleBtn = document.getElementById('resetPuzzleBtn');
      if (resetPuzzleBtn) resetPuzzleBtn.addEventListener('click', () => this.resetPuzzle());

      const modalClose = document.getElementById('modalClose');
      if (modalClose) modalClose.addEventListener('click', () => this.hideModal());

      const modalOverlay = document.getElementById('modalOverlay');
      if (modalOverlay) modalOverlay.addEventListener('click', () => this.hideModal());

      const codeEditor = document.getElementById('codeEditor');
      if (codeEditor) {
        codeEditor.addEventListener('input', () => {
          if (this._debounceHandle) clearTimeout(this._debounceHandle);
          this._debounceHandle = setTimeout(() => {
            this.resetHintTimer();
            this._scheduleSave();
          }, 250);
        });
      }

      // keyboard: Ctrl/Cmd + Enter to craft
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          this.craftItem();
        }
      });

      // inventory drag/drop
      this.setupDragAndDrop();
    } catch (err) {
      this._handleError(err, 'bindEvents');
    }
  }

  toggleTheme() {
    try {
      const body = document.body;
      const icon = document.querySelector('.theme-icon');
      body.classList.toggle('light-mode');
      const isLight = body.classList.contains('light-mode');
      if (icon) icon.textContent = isLight ? '🌙' : '☀️';
      localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark');
      // small particle feedback
      this.createParticles(document.querySelector('.theme-toggle'), isLight ? '☀️' : '🌙');
    } catch (err) {
      this._handleError(err, 'toggleTheme');
    }
  }

  /* ===========================
     Crafting: run user code in Web Worker & validate
     =========================== */
  async craftItem() {
    const codeEditor = document.getElementById('codeEditor');
    const craftBtn = document.getElementById('craftBtn');
    if (!codeEditor || !craftBtn) return;

    const code = codeEditor.value || '';
    if (!code.trim()) {
      this.updateConsole('Please write some code first!', 'error');
      return;
    }

    // UI: loading
    craftBtn.classList.add('loading');
    craftBtn.disabled = true;

    // short delay so UI updates
    await new Promise(r => setTimeout(r, 120));

    try {
      // easter eggs quick check
      if (this.checkEasterEggs(code)) {
        craftBtn.classList.remove('loading');
        craftBtn.disabled = false;
        return;
      }

      // basic sanitizer - block obvious tokens and huge uploads
      const s = this._basicSanitize(code);
      if (!s.ok) {
        this.updateConsole(`Forbidden or too-large code: ${s.reason}`, 'error');
        craftBtn.classList.remove('loading');
        craftBtn.disabled = false;
        return;
      }

      const recipe = (typeof RECIPES_DATA !== 'undefined') ? RECIPES_DATA[this.currentLevel] || {} : {};
      const execution = await this.executeCodeWithWorker(code, recipe).catch(err => { throw err; });
      const validated = this.interpretExecutionResult(execution);

      if (validated.success) {
        const item = validated.item;
        this.addToInventory(item);
        this.updateConsole(`✨ Successfully crafted: ${item.name}!`, 'success');
        this.addScore(100);
        this.createCraftingEffect();
        this.resetHintTimer();
        this.checkAchievements();
      } else {
        // fallback suggestion flow
        if (validated.fallbackSuggested) {
          this.updateConsole(`⚠️ ${validated.message} Using fallback item.`, 'warning');
          const fallbackItem = this._createFallbackItem(this.currentLevel);
          this.addToInventory(fallbackItem);
          this.updateConsole(`✨ Crafted fallback: ${fallbackItem.name}`, 'success');
          this.addScore(50);
          this.createCraftingEffect();
          this.resetHintTimer();
        } else {
          this.updateConsole(`❌ ${validated.message}`, 'error');
          if (validated.details) this.updateConsole(validated.details, 'info');
        }
      }
    } catch (err) {
      this._handleError(err, 'craftItem');
    } finally {
      craftBtn.classList.remove('loading');
      craftBtn.disabled = false;
    }
  }

  _basicSanitize(code) {
    try {
      // forbid direct DOM/Network/storage access
      const forbidden = ['document', 'window', 'XMLHttpRequest', 'fetch', 'importScripts', 'WebSocket', 'localStorage', 'indexedDB', 'eval', 'Function'];
      for (const token of forbidden) {
        if (code.includes(token)) return { ok: false, reason: token };
      }
      if (code.length > 16 * 1024) return { ok: false, reason: 'code too large' };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'sanitizer error' };
    }
  }

  executeCodeWithWorker(userCode, recipe = {}) {
    // runs code in worker, supports returning value or exposing function named recipe.expectedFunction
    return new Promise((resolve, reject) => {
      try {
        const expectedFn = recipe.expectedFunction || null;
        const testCalls = recipe.testCalls || [];

        // Worker source - intentionally minimal and isolated
        const workerSource = `
          // isolate globals
          var window = undefined;
          var document = undefined;
          var fetch = undefined;
          var XMLHttpRequest = undefined;
          var WebSocket = undefined;
          var importScripts = undefined;
          var localStorage = undefined;
          var indexedDB = undefined;
          var Function = undefined;
          var eval = undefined;

          // capture logs
          const logs = [];
          console = {
            log: function() { logs.push({ level: 'info', args: Array.from(arguments).map(String) }); },
            warn: function() { logs.push({ level: 'warn', args: Array.from(arguments).map(String) }); },
            error: function() { logs.push({ level: 'error', args: Array.from(arguments).map(String) }); }
          };

          self.onmessage = function(e) {
            try {
              const payload = e.data || {};
              const code = payload.code || "";
              const expectedFn = payload.expectedFn || null;
              const testCalls = payload.testCalls || [];
              var exports = {};
              var __result = undefined;

              // execute user code inside IIFE
              __result = (function(){
                "use strict";
                // user code begins
                ${userCode}
                // user code ends
              })();

              // if expected function is defined on self (i.e. top-level function),
              // call it according to testCalls
              if (expectedFn && typeof self[expectedFn] === 'function') {
                let lastOut;
                if (Array.isArray(testCalls) && testCalls.length > 0) {
                  for (let i = 0; i < testCalls.length; i++) {
                    const args = testCalls[i].args || [];
                    lastOut = self[expectedFn].apply(null, args);
                  }
                } else {
                  lastOut = self[expectedFn]();
                }
                postMessage({ type: 'success', result: lastOut, exports: [expectedFn], logs: logs });
                return;
              }

              // otherwise if IIFE returned something, return it
              postMessage({ type: 'success', result: __result, exports: [], logs: logs });
            } catch (err) {
              postMessage({ type: 'error', message: err && err.message ? err.message : String(err), logs: logs });
            }
          };
        `;

        const blob = new Blob([workerSource], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        let finished = false;

        const timer = setTimeout(() => {
          if (!finished) {
            finished = true;
            worker.terminate();
            URL.revokeObjectURL(url);
            reject(new Error('Code execution timed out. Possible infinite loop.'));
          }
        }, this._workerTimeout);

        worker.onmessage = (ev) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          worker.terminate();
          URL.revokeObjectURL(url);
          const data = ev.data || {};
          // relay logs
          if (Array.isArray(data.logs)) {
            data.logs.forEach(l => {
              const m = l.args.join(' ');
              // map levels: info/warn/error
              this.updateConsole(`> ${m}`, l.level === 'warn' ? 'warning' : (l.level === 'error' ? 'error' : 'info'));
            });
          }
          if (data.type === 'success') {
            resolve({ result: data.result, exports: data.exports || [] });
          } else {
            reject(new Error(data.message || 'Worker execution failed'));
          }
        };

        worker.onerror = (err) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          worker.terminate();
          URL.revokeObjectURL(url);
          reject(new Error(err && err.message ? err.message : 'Worker error'));
        };

        // post payload (not sending code to worker via postMessage to avoid needing to stringify userCode)
        worker.postMessage({ code: userCode, expectedFn: expectedFn, testCalls: testCalls });
      } catch (err) {
        reject(err);
      }
    });
  }

  interpretExecutionResult(execution) {
    try {
      const recipe = (typeof RECIPES_DATA !== 'undefined') ? RECIPES_DATA[this.currentLevel] || {} : {};
      const puzzle = (typeof PUZZLES_DATA !== 'undefined') ? PUZZLES_DATA[this.currentLevel] || {} : {};
      const result = execution && execution.result;

      // if execution returned object with name property -> candidate item
      if (result && typeof result === 'object' && result.name) {
        // check required properties per recipe
        if (Array.isArray(recipe.requiredProperties)) {
          for (const prop of recipe.requiredProperties) {
            if (!(prop in result)) {
              return { success: false, message: `Missing required property: ${prop}` };
            }
          }
        }

        // puzzle constraints (number checks etc.)
        if (puzzle && puzzle.requiredProperty && (puzzle.requiredProperty in result)) {
          const val = result[puzzle.requiredProperty];
          if (typeof val !== 'number' || val < puzzle.minValue) {
            return { success: false, message: `${puzzle.requiredProperty} must be >= ${puzzle.minValue}`, details: `Your value: ${val}` };
          }
        }

        if (puzzle && puzzle.additionalRequirement && !result[puzzle.additionalRequirement]) {
          return { success: false, message: `Must have property: ${puzzle.additionalRequirement}` };
        }

        return { success: true, item: result };
      }

      // If expected function exists but didn't return valid object
      const exportsList = execution && execution.exports || [];
      const expectedFunction = recipe.expectedFunction;
      if (expectedFunction && exportsList.includes(expectedFunction)) {
        return { success: false, message: `Found function '${expectedFunction}' but it didn't return valid object`, fallbackSuggested: true };
      }

      // try best-effort: suggest fallback if expectedFunction missing or mismatch
      if (expectedFunction) {
        return { success: false, message: `Expected function '${expectedFunction}' not found or did not produce valid item`, fallbackSuggested: true };
      }

      return { success: false, message: 'Code must return an object with "name" property or define expected function' };
    } catch (err) {
      return { success: false, message: 'Validation error' };
    }
  }

  /* ===========================
     Inventory Management & UI
     =========================== */
  addToInventory(item) {
    try {
      if (!item || typeof item !== 'object') return;
      // enrich item
      item.id = Date.now().toString(36) + Math.floor(Math.random() * 1000);
      item.craftedAt = new Date().toISOString();
      if (!item.icon) item.icon = this.getItemIcon(item.name);
      this.inventory.push(item);
      this.updateInventoryDisplay();
      this._scheduleSave();
    } catch (err) {
      this._handleError(err, 'addToInventory');
    }
  }

  getItemIcon(itemName) {
    if (!itemName) return '📦';
    const map = { hammer: '🔨', sword: '⚔️', 'magic': '✨', shield: '🛡️', potion: '🧪', bow: '🏹', axe: '🪓', staff: '🔮', dagger: '🗡️', crystal: '💎' };
    const low = itemName.toLowerCase();
    for (const k of Object.keys(map)) if (low.includes(k)) return map[k];
    if (low.includes('magical') || low.includes('magic')) return '✨';
    return '📦';
  }

  updateInventoryDisplay() {
    try {
      const grid = document.getElementById('inventoryGrid');
      const itemCount = document.getElementById('itemCount');
      if (!grid || !itemCount) return;

      grid.innerHTML = '';

      if (!this.inventory || this.inventory.length === 0) {
        grid.innerHTML = `<div class="inventory-empty"><div class="empty-icon">📦</div><div class="empty-text">No items yet</div><div class="empty-hint">Craft your first item!</div></div>`;
        itemCount.textContent = '0';
        return;
      }

      this.inventory.forEach((it, idx) => {
        const el = document.createElement('div');
        el.className = 'inventory-item';
        el.draggable = true;
        el.dataset.itemIndex = idx;

        const stats = [];
        if (it.damage !== undefined) stats.push(`DMG: ${it.damage}`);
        if (it.defense !== undefined) stats.push(`DEF: ${it.defense}`);
        if (it.magical) stats.push('Magical');
        if (it.material) stats.push(it.material);

        el.innerHTML = `
          <div class="item-icon">${it.icon || '📦'}</div>
          <div class="item-name">${it.name}</div>
          ${stats.length ? `<div class="item-stats">${stats.join(' • ')}</div>` : ''}
        `;

        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', idx.toString());
          el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.title = this._createItemTooltip(it);
        grid.appendChild(el);
      });

      itemCount.textContent = String(this.inventory.length);
    } catch (err) {
      this._handleError(err, 'updateInventoryDisplay');
    }
  }

  _createItemTooltip(item) {
    const lines = [`Name: ${item.name}`];
    if (item.damage !== undefined) lines.push(`Damage: ${item.damage}`);
    if (item.defense !== undefined) lines.push(`Defense: ${item.defense}`);
    if (item.material) lines.push(`Material: ${item.material}`);
    if (item.magical) lines.push('Type: Magical');
    return lines.join('\n');
  }

  /* ===========================
     Drag & Drop -> Puzzle
     =========================== */
  setupDragAndDrop() {
    try {
      const dropZone = document.getElementById('dropZone');
      if (!dropZone) return;
      dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
      dropZone.addEventListener('dragleave', (e) => { dropZone.classList.remove('drag-over'); });
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const idx = e.dataTransfer.getData('text/plain');
        const i = parseInt(idx, 10);
        const item = this.inventory[i];
        if (item) this.usePuzzleItem(item, i);
      });
    } catch (err) {
      this._handleError(err, 'setupDragAndDrop');
    }
  }

  usePuzzleItem(item, itemIndex) {
    try {
      const puzzle = (typeof PUZZLES_DATA !== 'undefined') ? PUZZLES_DATA[this.currentLevel] || null : null;
      if (!puzzle) {
        this.updateConsole('No puzzle for current level', 'warning');
        return;
      }

      const nameMatch = item.name.toLowerCase().includes(puzzle.requiredItem.toLowerCase());
      const hasProp = (puzzle.requiredProperty in item);
      const meetsMin = hasProp && typeof item[puzzle.requiredProperty] === 'number' && item[puzzle.requiredProperty] >= puzzle.minValue;
      const meetsAdditional = !puzzle.additionalRequirement || item[puzzle.additionalRequirement];

      if (nameMatch && meetsMin && meetsAdditional) {
        this.solvePuzzle(item, itemIndex);
      } else {
        let err = `The ${item.name} doesn't meet requirements:\n`;
        if (!nameMatch) err += `- Must be: ${puzzle.requiredItem}\n`;
        if (!meetsMin) err += `- ${puzzle.requiredProperty} must be >= ${puzzle.minValue}\n`;
        if (!meetsAdditional) err += `- Must have: ${puzzle.additionalRequirement}\n`;
        this.updateConsole('Item does not meet puzzle requirements', 'error');
        this.showModal('Invalid Item', err.trim());
      }
    } catch (err) {
      this._handleError(err, 'usePuzzleItem');
    }
  }

  solvePuzzle(item, itemIndex) {
    try {
      // remove used item
      this.inventory.splice(itemIndex, 1);
      this.updateInventoryDisplay();

      // scoring logic
      const baseBonus = this.currentLevel * 200;
      let qBonus = 0;
      if (item.magical) qBonus += 100;
      if (item.damage && item.damage > 20) qBonus += 50;
      if (item.material) qBonus += 25;
      const total = baseBonus + qBonus;
      this.addScore(total);
      this.createSuccessEffect();
      this.updateConsole(`Puzzle solved with ${item.name}! +${total} points`, 'success');
      if (qBonus) this.updateConsole(`Quality bonus: +${qBonus} points`, 'info');

      // progress to next level or finish
      this.saveGameState();
      if (this.currentLevel < this.maxLevel) {
        setTimeout(() => this.nextLevel(), 1200);
      } else {
        setTimeout(() => this.gameComplete(), 1200);
      }
    } catch (err) {
      this._handleError(err, 'solvePuzzle');
    }
  }

  nextLevel() {
    try {
      this.currentLevel = Math.min(this.maxLevel, this.currentLevel + 1);
      this.loadCurrentLevel();
      this.createLevelUpEffect();
      this.showModal('Level Complete!', `You've advanced to Level ${this.currentLevel}. New challenges await!`);
      this.resetHintTimer();
      this._scheduleSave();
    } catch (err) {
      this._handleError(err, 'nextLevel');
    }
  }

  gameComplete() {
    try {
      const bonus = 1000;
      this.addScore(bonus);
      this.showModal('Game Complete!', `Amazing! Final score: ${this.score.toLocaleString()}\n\nCompletion Bonus: +${bonus}\nYou are a Code Craft Master!`);
      this.createConfettiEffect();
      this.unlockAchievement('game-master', 'Code Craft Master', 'Complete all levels');
      if (this.score >= 5000) this.unlockAchievement('high-scorer', 'High Scorer', 'Score 5000+');
      this.saveGameState();
    } catch (err) {
      this._handleError(err, 'gameComplete');
    }
  }

  loadCurrentLevel() {
    try {
      const recipe = (typeof RECIPES_DATA !== 'undefined') ? RECIPES_DATA[this.currentLevel] : null;
      const puzzle = (typeof PUZZLES_DATA !== 'undefined') ? PUZZLES_DATA[this.currentLevel] : null;
      const recipeContent = document.getElementById('recipeContent');
      const puzzleDescription = document.getElementById('puzzleDescription');
      const puzzleTarget = document.getElementById('puzzleTarget');
      if (recipe && recipeContent) recipeContent.innerHTML = recipe.description;
      if (puzzle && puzzleDescription) puzzleDescription.textContent = puzzle.description;
      if (puzzle && puzzleTarget) {
        puzzleTarget.innerHTML = `
          <div class="target-icon">${puzzle.target}</div>
          <div class="target-label">${puzzle.targetLabel}</div>
          <div class="target-hint">Requires: ${puzzle.requiredItem} (${puzzle.requiredProperty} >= ${puzzle.minValue})</div>
        `;
      }
      this.updateDisplay();
    } catch (err) {
      this._handleError(err, 'loadCurrentLevel');
    }
  }

  updateDisplay() {
    try {
      const currentLevelEl = document.getElementById('currentLevel');
      const scoreValueEl = document.getElementById('scoreValue');
      const progressFillEl = document.getElementById('progressFill');
      if (currentLevelEl) currentLevelEl.textContent = String(this.currentLevel);
      if (scoreValueEl) scoreValueEl.textContent = this.score.toLocaleString();
      if (progressFillEl) {
        const progress = ((this.currentLevel - 1) / Math.max(1, (this.maxLevel - 1))) * 100;
        progressFillEl.style.width = `${Math.min(progress, 100)}%`;
      }
    } catch (err) {
      this._handleError(err, 'updateDisplay');
    }
  }

  addScore(points) {
    try {
      this.score += Number(points) || 0;
      this.updateDisplay();
      const scoreEl = document.querySelector('.score');
      if (scoreEl) {
        gsap.fromTo(scoreEl, { scale: 1 }, { scale: 1.12, duration: 0.12, yoyo: true, repeat: 1 });
      }
      this._scheduleSave();
    } catch (err) {
      this._handleError(err, 'addScore');
    }
  }

  /* ===========================
     Console helpers
     =========================== */
  updateConsole(message, type = 'info') {
    try {
      this._consoleCount++;
      if (this._consoleCount > this._consoleLimit) {
        if (this._consoleCount === this._consoleLimit + 1) this._addConsoleMessage('Console truncated', 'warning');
        return;
      }
      this._addConsoleMessage(message, type);
    } catch (err) {
      console.error('Console update failed', err);
    }
  }

  _addConsoleMessage(message, type = 'info') {
    try {
      const consoleContent = document.getElementById('consoleContent');
      if (!consoleContent) return;
      const ts = new Date().toLocaleTimeString();
      const el = document.createElement('div');
      el.className = `console-${type}`;
      el.textContent = `[${ts}] ${message}`;
      consoleContent.appendChild(el);
      consoleContent.scrollTop = consoleContent.scrollHeight;
    } catch (err) {
      console.error('addConsoleMessage error', err);
    }
  }

  clearCode() {
    try {
      const codeEditor = document.getElementById('codeEditor');
      const consoleContent = document.getElementById('consoleContent');
      if (codeEditor) codeEditor.value = '';
      if (consoleContent) consoleContent.innerHTML = '<div class="console-info">Console cleared</div>';
      this._consoleCount = 0;
    } catch (err) {
      this._handleError(err, 'clearCode');
    }
  }

  resetPuzzle() {
    this.updateConsole('Puzzle reset', 'info');
    this.loadCurrentLevel();
  }

  showHint() {
    try {
      const recipe = (typeof RECIPES_DATA !== 'undefined') ? RECIPES_DATA[this.currentLevel] || null : null;
      if (recipe && recipe.example) {
        this.showModal('Hint', `Example for Level ${this.currentLevel}:\n\n${recipe.example}`);
        this.resetHintTimer();
      } else {
        this.showModal('Hint', 'No hint available for this level.');
      }
    } catch (err) {
      this._handleError(err, 'showHint');
    }
  }

  startHintTimer() {
    this.resetHintTimer();
    this.hintTimer = setTimeout(() => {
      const hintBtn = document.getElementById('hintBtn');
      if (hintBtn) {
        hintBtn.style.animation = 'pulse 1s infinite';
        hintBtn.style.background = 'var(--warning)';
      }
      this.showModal('Need Help?', 'You\'ve been on this level for a while. Click Hint for an example.');
    }, this.hintTimeout);
  }

  resetHintTimer() {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    const hintBtn = document.getElementById('hintBtn');
    if (hintBtn) {
      hintBtn.style.animation = '';
      hintBtn.style.background = '';
    }
    this.hintTimer = setTimeout(() => {
      const hintBtn2 = document.getElementById('hintBtn');
      if (hintBtn2) {
        hintBtn2.style.animation = 'pulse 1s infinite';
        hintBtn2.style.background = 'var(--warning)';
      }
      this.showModal('Need Help?', 'You\'ve been on this level for a while. Click Hint for an example.');
    }, this.hintTimeout);
  }

  checkAchievements() {
    try {
      if (this.inventory.length >= 1 && !this.achievements.includes('first-craft')) {
        this.unlockAchievement('first-craft', 'First Steps', 'Craft your first item');
      }
      if (this.inventory.length >= 5 && !this.achievements.includes('collector')) {
        this.unlockAchievement('collector', 'Collector', 'Craft 5 items');
      }
      const hasMagic = this.inventory.some(i => i.magical);
      if (hasMagic && !this.achievements.includes('magic-user')) {
        this.unlockAchievement('magic-user', 'Magic User', 'Craft a magical item');
      }
    } catch (err) {
      this._handleError(err, 'checkAchievements');
    }
  }

  unlockAchievement(id, title, description) {
    try {
      if (!this.achievements.includes(id)) {
        this.achievements.push(id);
        setTimeout(() => {
          this.showModal('Achievement Unlocked!', `${title}\n\n${description}`);
        }, 400);
        this.createConfettiEffect();
        this.addScore(50);
        this._scheduleSave();
      }
    } catch (err) {
      this._handleError(err, 'unlockAchievement');
    }
  }

  showModal(title, body) {
    try {
      const modal = document.getElementById('modal');
      const modalTitle = document.getElementById('modalTitle');
      const modalBody = document.getElementById('modalBody');
      if (!modal || !modalTitle || !modalBody) return;
      modalTitle.textContent = title;
      modalBody.style.whiteSpace = 'pre-wrap';
      modalBody.textContent = body;
      modal.classList.add('show');
    } catch (err) {
      this._handleError(err, 'showModal');
    }
  }

  hideModal() {
    try {
      const modal = document.getElementById('modal');
      if (modal) modal.classList.remove('show');
    } catch (err) {
      this._handleError(err, 'hideModal');
    }
  }

  /* ===========================
     Visual effects (particles / confetti / craft)
     =========================== */
  createParticles(element, emoji = '✨') {
    try {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const container = document.getElementById('particlesContainer');
      if (!container) return;
      for (let i = 0; i < 10; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.textContent = emoji;
        // position near center of element
        p.style.left = (rect.left + rect.width / 2 + (Math.random() * 40 - 20)) + 'px';
        p.style.top = (rect.top + rect.height / 2 + (Math.random() * 40 - 20)) + 'px';
        container.appendChild(p);
        setTimeout(() => { if (container.contains(p)) container.removeChild(p); }, 2000);
      }
    } catch (err) { /* ignore visual errors */ }
  }

  createCraftingEffect() {
    try {
      const craftBtn = document.getElementById('craftBtn');
      if (!craftBtn) return;
      this.createParticles(craftBtn, '⚡');
      craftBtn.classList.add('crafting');
      setTimeout(() => craftBtn.classList.remove('crafting'), 900);
    } catch (err) {}
  }

  createSuccessEffect() {
    try {
      const dropZone = document.getElementById('dropZone');
      if (!dropZone) return;
      this.createParticles(dropZone, '🎉');
      gsap.fromTo(dropZone, { scale: 1 }, { scale: 1.08, duration: 0.2, yoyo: true, repeat: 1 });
    } catch (err) {}
  }

  createLevelUpEffect() {
    try {
      const progress = document.querySelector('.progress-bar');
      if (!progress) return;
      this.createParticles(progress, '🌟');
      gsap.fromTo(progress, { scale: 1 }, { scale: 1.03, duration: 0.18, yoyo: true, repeat: 1 });
    } catch (err) {}
  }

  createConfettiEffect() {
    try {
      const container = document.getElementById('particlesContainer');
      if (!container) return;
      const emojis = ['🎉', '🎊', '⭐', '✨', '🎆'];
      for (let i = 0; i < 24; i++) {
        setTimeout(() => {
          const p = document.createElement('div');
          p.className = 'particle';
          p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
          p.style.left = Math.random() * window.innerWidth + 'px';
          p.style.top = '-30px';
          p.style.fontSize = (Math.random() * 16 + 12) + 'px';
          container.appendChild(p);
          let pos = -30;
          const interval = setInterval(() => {
            pos += Math.random() * 8 + 3;
            p.style.top = pos + 'px';
            if (pos > window.innerHeight + 60) {
              clearInterval(interval);
              if (container.contains(p)) container.removeChild(p);
            }
          }, 16);
        }, i * 60);
      }
    } catch (err) {}
  }

  /* ===========================
     Persistence
     =========================== */
  saveGameState() {
    try {
      const snapshot = {
        currentLevel: this.currentLevel,
        score: this.score,
        inventory: this.inventory,
        achievements: this.achievements,
        lastPlayed: new Date().toISOString()
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
    } catch (err) {
      console.error('save failed', err);
    }
  }

  _scheduleSave() {
    if (this._debounceSaveHandle) clearTimeout(this._debounceSaveHandle);
    this._debounceSaveHandle = setTimeout(() => this.saveGameState(), 700);
  }

  loadGameState() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const state = JSON.parse(raw);
        this.currentLevel = state.currentLevel || 1;
        this.score = state.score || 0;
        this.inventory = state.inventory || [];
        this.achievements = state.achievements || [];
        this.updateInventoryDisplay();
      }
      const theme = localStorage.getItem(THEME_KEY);
      if (theme === 'light') {
        document.body.classList.add('light-mode');
        const icon = document.querySelector('.theme-icon');
        if (icon) icon.textContent = '🌙';
      }
    } catch (err) {
      console.error('load failed', err);
    }
  }

  /* ===========================
     Utilities / easter eggs / fallback
     =========================== */
  checkEasterEggs(code) {
    try {
      const l = code.toLowerCase();
      if (l.includes('konami') || l.includes('up up down down')) {
        this.createConfettiEffect();
        this.addScore(1000);
        this.updateConsole('Konami Code detected! +1000 bonus!', 'success');
        this.unlockAchievement('konami', 'Konami Master', 'Found the code');
        return true;
      }
      if (l.includes('hello world')) {
        this.createParticles(document.getElementById('codeEditor'), '👋');
        this.updateConsole('Hello World detected!', 'info');
        this.addScore(100);
        return false; // allow normal crafting too
      }
    } catch (err) {}
    return false;
  }

  _createFallbackItem(level) {
    const map = {
      1: { name: 'Basic Hammer', damage: 10, icon: '🔨' },
      2: { name: 'Iron Sword', damage: 18, material: 'iron', icon: '⚔️' },
      3: { name: 'Magic Hammer', damage: 32, magical: true, materials: [{ name: 'crystal', power: 32 }], icon: '🔥' }
    };
    return map[level] || { name: 'Fallback Item', damage: 5, icon: '📦' };
  }

  _createItemTooltip(item) {
    return this._createItemTooltip; // placeholder (not used)
  }

  _handleError(error, context = '') {
    try {
      const m = error && error.message ? error.message : String(error);
      console.error('Error', context, error);
      this.updateConsole(`Error${context ? ' ('+context+')' : ''}: ${m}`, 'error');
    } catch (err) {
      console.error(err);
    }
  }
}

/* ===========================
   Instantiate game
   =========================== */
const GAME = new CodeCraftGame();
