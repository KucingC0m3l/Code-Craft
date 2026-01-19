# 🛠️ Code Craff

## 🎮 Fitur Utama

- **Crafting System (Code → Item)**
  - Tulis snippet JS dalam editor → jika valid → item muncul dalam inventory.
  - Contoh:
    ```js
    function craftHammer() { return { name: "Hammer", damage: 10 }; }
    craftHammer();
    ```

- **Inventory & Puzzle Interaction**
  - Item disimpan dalam inventory grid.
  - Drag & drop item ke puzzle area untuk solve challenge.

- **Dynamic Recipes**
  - Setiap level ada recipe unik.
  - Level makin tinggi → kombinasi item makin kompleks.

- **Save & Load**
  - Progress (inventory, level) auto-simpan dalam **localStorage**.

- **Visual Feedback**
  - Animasi crafting (glow, sparks).
  - Puzzle ada animasi bila item digunakan.
  - Confetti bila level complete 🎉.

---

## 🎨 UI/UX (Trend 2025)

- Dark mode by default, light mode toggle.
- Minimalis + futuristik typography (Inter / Space Grotesk).
- Layout responsive (desktop & mobile).
- Micro-interactions (hover glow, ripple button).

---


---

## ⚙️ Teknologi Digunakan

- **Frontend sahaja**: HTML, CSS, JavaScript.
- **Animation**: GSAP / Anime.js.
- **Data**: JSON (recipes, puzzles).
- **Save/Load**: LocalStorage.
- **Sandbox**: Web Worker untuk run snippet user secara selamat.

---

## 🚀 Cara Guna

1. Clone repo:
   ```bash
   git clone https://github.com/username/codecraft.git
2. Buka index.html dalam browser (no server needed).
3. Start crafting item & solve puzzle 🎮.

 ## 🏆 Extra Features

- **Combo crafting** → gabungkan beberapa item jadi item baru.
- **Hint system** → auto keluar kalau user stuck > 2 minit.
- **Achievements** → unlock title bila capai milestone.
- **Easter eggs** → code rahsia trigger animasi khas.

