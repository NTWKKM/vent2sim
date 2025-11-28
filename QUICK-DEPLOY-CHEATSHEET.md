# 🚀 QUICK DEPLOY CHEAT SHEET

## 5-Minute Quick Start (TL;DR)

```bash
# 1️⃣ SETUP LOCAL (Terminal)
mkdir vent2sim && cd vent2sim
git init

# 2️⃣ COPY FILES
# Copy from this chat:
# - src/physics/ (4 files)
# - src/content/ (1 file)
# - src/components/ (2 files)
# - src/main.jsx
# - package.json, vite.config.js, index.html, etc

# 3️⃣ INSTALL & TEST
npm install
npm run dev
# Open http://localhost:5173 ✓ Click around, test tooltips

# 4️⃣ PUSH TO GITHUB
git add .
git commit -m "Initial commit: VentSim v2.0"
git remote add origin https://github.com/YOUR-USERNAME/vent2sim.git
git branch -M main
git push -u origin main

# 5️⃣ DEPLOY ON VERCEL
# Go to vercel.com/new
# Click "Import from GitHub"
# Select vent2sim repo
# Framework: Vite (auto-detect)
# Click Deploy
# Wait 2-5 min...
# ✅ Done! Your URL: https://vent2sim.vercel.app
```

---

## Files You Need to Copy

```
FROM THIS CHAT → TO: vent2sim/src/

✅ physics-resistance.js → src/physics/resistance.js
✅ physics-compliance.js → src/physics/compliance.js
✅ physics-gasExchange.js → src/physics/gasExchange.js
✅ physics-pathologyPresets.js → src/physics/pathologyPresets.js

✅ content-tooltips.js → src/content/tooltips.js

✅ component-InfoTooltip.jsx → src/components/InfoTooltip.jsx
✅ component-GraphOnlyView.jsx → src/components/GraphOnlyView.jsx

✅ main-refactored-structure.jsx → src/main.jsx

✅ package-updated.json → package.json
```

---

## Commands Reference

### Local Dev
```bash
npm install              # Install packages
npm run dev              # Start dev server (http://localhost:5173)
npm run build            # Build for production
npm run lint             # Check code
```

### Git
```bash
git status               # Check status
git add .                # Add all files
git commit -m "message"  # Commit
git push origin main     # Push to GitHub
```

### Test Points
```bash
□ Desktop (1024px) - Full layout with graphs
□ Tablet (768px) - Responsive adapt
□ Mobile (375px) - Tab navigation
□ Hover "?" on values - Tooltips appear
□ Toggle EN/ไทย - Language changes
□ Click "📊 Study Mode" - Fullscreen graphs
```

---

## GitHub Setup

1. Go: github.com/new
2. Name: `vent2sim`
3. Public ✓
4. Create

---

## Vercel Deployment

1. Go: vercel.com/new
2. Import from GitHub
3. Select: vent2sim
4. Framework: Vite (auto)
5. Deploy
6. Wait → Done!
7. URL: `https://vent2sim.vercel.app`

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Module not found` | Check imports, file paths correct |
| `Build fails` | Run locally: `npm run build` first |
| `Dependencies error` | `npm install` or delete node_modules + reinstall |
| `Can't see changes` | Refresh browser, check git push |

---

## After Deploy

### Share Link
```
GitHub: https://github.com/YOUR-USERNAME/vent2sim
Live: https://vent2sim.vercel.app
```

### Future Updates
```bash
git add .
git commit -m "Update: description"
git push origin main
# Vercel auto-deploys! ✅
```

---

## 📋 Checklist

- [ ] Created vent2sim folder
- [ ] Copied all files
- [ ] npm install works
- [ ] npm run dev works
- [ ] Tested locally (tooltips, responsive)
- [ ] git push to GitHub
- [ ] Vercel deployment shows "✓ Production"
- [ ] Live URL works
- [ ] Share with team!

---

**Total Time: ~30 minutes**  
**Difficulty: Easy** ⭐⭐  
**Result: Live app deployed! 🎉**
