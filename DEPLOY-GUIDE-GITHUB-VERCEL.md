# 📦 Guide: Deploy VentSim to New Repository & Vercel

## 🎯 Complete Step-by-Step Guide

### Phase 1: Prepare Local Project (15 minutes)

#### Step 1.1: Create New Local Project
```bash
# Create new directory
mkdir vent2sim
cd vent2sim

# Initialize git
git init

# Create .gitignore
cat > .gitignore << 'EOF'
# Dependencies
node_modules/
.pnp
.pnp.js

# Testing
coverage/

# Production
/build
/dist

# Misc
.DS_Store
.env
.env.local
.env.*.local
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Editor directories and files
.idea
.vscode
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
EOF
```

#### Step 1.2: Copy Configuration Files
```bash
# Copy from your original project
cp ../original-path/package.json .
cp ../original-path/vite.config.js .
cp ../original-path/index.html .
cp ../original-path/tailwind.config.js .
cp ../original-path/postcss.config.js .
cp ../original-path/.eslintrc.json .

# Create necessary config for Vercel
cat > vercel.json << 'EOF'
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "env": {
    "VITE_API_URL": "@vite_api_url"
  }
}
EOF
```

#### Step 1.3: Create Folder Structure
```bash
# Create all folders
mkdir -p src/physics
mkdir -p src/content
mkdir -p src/components/Layout
mkdir -p src/components/Panels
mkdir -p src/hooks
mkdir -p src/utils
mkdir -p tests
mkdir -p docs
mkdir -p public

# Create empty index files
touch src/index.css
touch src/index.jsx
touch public/.gitkeep
```

#### Step 1.4: Copy All New Files
```bash
# Physics modules
cp physics-resistance.js src/physics/resistance.js
cp physics-compliance.js src/physics/compliance.js
cp physics-gasExchange.js src/physics/gasExchange.js
cp physics-pathologyPresets.js src/physics/pathologyPresets.js

# Content & Components
cp content-tooltips.js src/content/tooltips.js
cp component-InfoTooltip.jsx src/components/InfoTooltip.jsx
cp component-GraphOnlyView.jsx src/components/GraphOnlyView.jsx

# Main app
cp main-refactored-structure.jsx src/main.jsx

# Documentation
cp REFACTOR-GUIDE.md .
cp SUMMARY-ALL-4-FEATURES.md .
cp PROJECT-STRUCTURE-COMPLETE.md .
cp README-REFACTOR-COMPLETE.md README.md
```

#### Step 1.5: Create README.md (For GitHub)
```bash
cat > README.md << 'EOF'
# 🫁 VentSim Dual-Lungs v2.0

Advanced ventilator simulator with dual-lung pathology support.

## ✨ Features

- ✅ VCV, PCV, PSV modes
- ✅ 8 pathology presets (ARDS, COPD, Emphysema, etc)
- ✅ Dual-lung asymmetric support
- ✅ Real-time P/V/F loops
- ✅ Responsive design (desktop/tablet/mobile)
- ✅ Study mode for teaching
- ✅ Bilingual tooltips (EN/ไทย)
- ✅ Educational content built-in

## 🚀 Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

## 📚 Documentation

- [REFACTOR-GUIDE.md](./REFACTOR-GUIDE.md) - Architecture
- [SUMMARY-ALL-4-FEATURES.md](./SUMMARY-ALL-4-FEATURES.md) - Features overview
- [PROJECT-STRUCTURE-COMPLETE.md](./PROJECT-STRUCTURE-COMPLETE.md) - File structure

## 🏗️ Project Structure

```
src/
├── physics/           # Physics modules (pure functions)
├── content/          # Educational content (tooltips)
├── components/       # React components
├── main.jsx         # Main app
└── index.jsx        # React entry
```

## 🎓 Use Cases

- Medical education
- Clinical training
- Ventilator mechanics learning
- ICU teaching rounds

## 📱 Responsive Design

- **Desktop (1024px+):** Full 2-column layout
- **Tablet (768px):** Responsive adapt
- **Mobile (<768px):** Tab navigation

## 🌐 Languages

- 🇬🇧 English
- 🇹🇭 Thai (ไทย)

## 📦 Built With

- React 18
- Vite
- Tailwind CSS
- Lucide React (icons)

## 📄 License

MIT

## 👨‍💻 Contributing

Contributions welcome! Please read [REFACTOR-GUIDE.md](./REFACTOR-GUIDE.md) first.

---

**Made with ❤️ for medical education**
EOF
```

#### Step 1.6: Install Dependencies & Test
```bash
# Install packages
npm install

# Check for errors
npm run lint

# Test dev server locally
npm run dev
# Visit http://localhost:5173
# Test all features, tooltips, responsive design
# Ctrl+C to stop
```

---

### Phase 2: Create GitHub Repository (10 minutes)

#### Step 2.1: Create Repo on GitHub
1. Go to [github.com/new](https://github.com/new)
2. **Repository name:** `vent2sim`
3. **Description:** "VentSim Dual-Lungs v2.0 - Advanced ventilator simulator"
4. **Visibility:** Public (or Private if you prefer)
5. **Initialize:** DO NOT check "Initialize with README" (we already have one)
6. Click **Create repository**

#### Step 2.2: Push to GitHub
```bash
# Add remote
git remote add origin https://github.com/YOUR-USERNAME/vent2sim.git

# Rename main branch (if needed)
git branch -M main

# Add all files
git add .

# Initial commit
git commit -m "🎉 Initial commit: VentSim v2.0 refactored architecture

- Physics modules separated (resistance, compliance, gas exchange)
- Educational tooltips (30+ parameters, bilingual EN/TH)
- Responsive design (desktop, tablet, mobile)
- Study mode fullscreen graphs
- 8 pathology presets with clinical tips"

# Push to GitHub
git push -u origin main
```

**Expected output:**
```
Enumerating objects: ...
Counting objects: ...
Delta compression using ...
Writing objects: ...
Total ... (delta ...), reused ...
remote: 
remote: Create a pull request for 'main' on GitHub by visiting:
remote:      https://github.com/YOUR-USERNAME/vent2sim/pull/new/main
remote:
To https://github.com/YOUR-USERNAME/vent2sim.git
 * [new branch]      main -> main
Branch 'main' is set to track remote branch 'main' from 'origin'.
```

#### Step 2.3: Verify on GitHub
- Open https://github.com/YOUR-USERNAME/vent2sim
- Should see all files uploaded ✅

---

### Phase 3: Deploy to Vercel (15 minutes)

#### Step 3.1: Connect Vercel to GitHub
1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **Import Project**
3. Select **GitHub** as source
4. **Authenticate** with GitHub (if not already)
5. Search for repository: **vent2sim**
6. Click **Import**

#### Step 3.2: Configure Vercel Project
```
Project Name: vent2sim (auto-filled)

Framework: Vite ✅
Root Directory: ./ ✅

Build Command: npm run build ✅
Output Directory: dist ✅
Install Command: npm install ✅

Environment Variables: (leave empty for now)
```

Click **Deploy**

**Expected:** Vercel starts building...
```
✓ Build 51s
✓ Analytics Engine
✓ Prerender 1 ISR route in 2s
✓ Deployment complete
```

#### Step 3.3: Wait for Deployment
- Takes 2-5 minutes first time
- Check deployment status in Vercel dashboard
- Should see: **✓ Production** (green checkmark)

#### Step 3.4: Get Your Vercel URL
```
Your Vercel URL:
https://vent2sim.vercel.app
```

**Test it:**
- Open the URL in browser
- Test all features (tooltips, responsive, study mode)
- Share with team!

---

### Phase 4: Setup Automatic Deployments (5 minutes)

**Vercel automatically deploys when you:**
```bash
# Push to GitHub
git push origin main

# Or create pull request
# Vercel creates preview deployment automatically
```

#### Step 4.1: Enable Preview Deployments
In Vercel dashboard:
1. Go to your project: **vent2sim**
2. Settings → **Git**
3. **Deploy on Push:** Enable ✅
4. **Preview Deployments:** Enable ✅

#### Step 4.2: Add GitHub Badge (Optional)
```bash
# Add to README.md
cat >> README.md << 'EOF'

## 🚀 Deployment

[![Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/YOUR-USERNAME/vent2sim)

Deployed on [Vercel](https://vercel.com)

Live: https://vent2sim.vercel.app
EOF

git add README.md
git commit -m "docs: add Vercel deployment badge"
git push origin main
```

---

## 📋 Complete Checklist

### Local Setup
- [ ] Created `vent2sim` directory
- [ ] Copied all config files (package.json, vite.config.js, etc)
- [ ] Created folder structure
- [ ] Copied all source files (physics, content, components)
- [ ] Copied documentation
- [ ] Created comprehensive README.md
- [ ] Ran `npm install`
- [ ] Tested locally with `npm run dev`
- [ ] All features working (tooltips, responsive, study mode)
- [ ] Created .gitignore

### GitHub Setup
- [ ] Created repository on GitHub: `vent2sim`
- [ ] Initialized git locally
- [ ] Added remote: `git remote add origin`
- [ ] Committed all files
- [ ] Pushed to GitHub: `git push -u origin main`
- [ ] Verified files on GitHub

### Vercel Setup
- [ ] Connected Vercel to GitHub account
- [ ] Imported `vent2sim` repository
- [ ] Configured build settings
- [ ] Deployment successful (green checkmark)
- [ ] Got production URL: `https://vent2sim.vercel.app`
- [ ] Tested deployed version
- [ ] Enabled auto-deployments

---

## 🔄 Workflow After Deployment

### Make Changes Locally
```bash
# Make changes to code
# Edit files, test with npm run dev

# When ready to deploy:
git add .
git commit -m "feat: add new feature"
git push origin main

# Vercel automatically deploys! ✅
# Check: https://vercel.com/dashboard
```

### Create Pull Request Workflow (Optional)
```bash
# Create feature branch
git checkout -b feature/new-feature

# Make changes, commit
git add .
git commit -m "feat: add new feature"

# Push branch
git push origin feature/new-feature

# Open PR on GitHub
# Vercel creates preview deployment
# Test, merge when ready
# Vercel deploys to production
```

---

## 🛠️ Useful Commands

```bash
# Local development
npm run dev              # Start dev server
npm run build            # Build for production
npm run preview          # Preview production build
npm run lint             # Check code quality

# Git operations
git status              # Check status
git log --oneline       # View commit history
git diff                # See changes

# Vercel CLI (optional)
npm i -g vercel         # Install Vercel CLI
vercel                  # Deploy from CLI
vercel --prod           # Deploy to production
```

---

## 📊 Project URLs After Setup

| Service | URL | Status |
|---------|-----|--------|
| GitHub | https://github.com/YOUR-USERNAME/vent2sim | Source code |
| Vercel | https://vent2sim.vercel.app | Live app |
| Local | http://localhost:5173 | Development |

---

## ⚠️ Troubleshooting

### "Build failed on Vercel"
```bash
# Check locally first
npm run build
npm run preview

# If works locally, check:
# 1. All dependencies installed: npm install
# 2. No hardcoded paths
# 3. All imports correct
# 4. Environment variables set (if needed)
```

### "Module not found" error
```bash
# Verify file structure
ls -la src/physics/
ls -la src/content/
ls -la src/components/

# Check imports in main.jsx
# Should be: import { ... } from './physics/resistance'
# Not: import { ... } from '../physics/resistance'
```

### "Cannot find module 'react'"
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Then push again
git add package-lock.json
git commit -m "chore: regenerate lock file"
git push origin main
```

---

## 🎉 Success Criteria

✅ Repository created on GitHub  
✅ All files pushed successfully  
✅ Vercel deployment successful  
✅ Live URL working  
✅ All features functional (tooltips, responsive, study mode)  
✅ Can push changes and auto-deploy  

---

## 📚 Next Steps

After deployment:

1. **Share with team:**
   ```
   GitHub: https://github.com/YOUR-USERNAME/vent2sim
   Live: https://vent2sim.vercel.app
   ```

2. **Add team members to GitHub** (if collaborative)
   - Settings → Collaborators

3. **Enable branch protection** (optional)
   - Settings → Branches → Add rule

4. **Monitor deployment status**
   - Vercel Dashboard
   - GitHub Actions (if enabled)

5. **Continue development:**
   - Create feature branches
   - Make pull requests
   - Auto-deploy when merged

---

## 📞 Quick Reference

### Initial Setup (One-time)
```bash
mkdir vent2sim && cd vent2sim
git init
# ... copy files ...
npm install
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-USERNAME/vent2sim.git
git push -u origin main
# Connect on Vercel and deploy
```

### Future Updates
```bash
# Make changes
git add .
git commit -m "Update: description"
git push origin main
# Vercel automatically deploys!
```

---

**You're all set! 🚀**

Your VentSim is now:
- ✅ On GitHub (source control)
- ✅ On Vercel (deployed & live)
- ✅ Auto-deploying (push = deploy)
- ✅ Shareable (one link!)
- ✅ Collaborative (add team members)

Happy deploying! 🎊
