# VentSim Dual-Lungs - Refactored Architecture Guide

## 📋 Overview

โปรเจกต์นี้ได้ถูก refactor ให้มีโครงสร้าง modular และ maintainable มากขึ้น พร้อมฟีเจอร์ใหม่ๆ ดังนี้:

✅ **แยกฟังก์ชันฟิสิกส์** - ทดสอบและขยายได้ง่าย  
✅ **ระบบ Tooltip/Info** - ช่วยในการศึกษาทางคลินิก  
✅ **Responsive Design** - ใช้ได้บน PC, tablet, mobile  
✅ **Study Mode** - Fullscreen graph view สำหรับการสอน  

---

## 🗂️ Project Structure

```
src/
├── physics/
│   ├── resistance.js              ✨ NEW - Airway resistance calculation
│   ├── compliance.js              ✨ NEW - Lung compliance & hysteresis
│   ├── gasExchange.js             ✨ NEW - SpO2, EtCO2 calculations
│   └── pathologyPresets.js        ✨ NEW - Disease preset database
│
├── content/
│   └── tooltips.js                ✨ NEW - Bilingual tooltip content (EN/TH)
│
├── components/
│   ├── InfoTooltip.jsx            ✨ NEW - Reusable info popup
│   ├── GraphOnlyView.jsx          ✨ NEW - Study mode fullscreen
│   ├── Layout/                    📝 TO DO
│   │   ├── AppLayout.jsx
│   │   ├── Header.jsx
│   │   └── MainGrid.jsx
│   └── Panels/                    📝 TO DO
│       ├── WaveformsPanel.jsx
│       ├── MonitoringPanel.jsx
│       └── ControlsPanel.jsx
│
├── main.jsx                       ♻️ REFACTORED - Import modules, responsive layout
├── package.json
├── index.html
└── vite.config.js
```

---

## ✨ What's New - ทั้ง 4 ข้อที่พัฒนา

### 1️⃣ แยกฟังก์ชันฟิสิกส์ (`src/physics/`)

#### ก่อนหน้า ❌
- ทุกฟิสิกส์อยู่ใน main.jsx (~77KB ไฟล์เดียว)
- ยากต่อการทดสอบและขยายฟีเจอร์
- ความซับซ้อน coupling สูง

#### ตอนนี้ ✅
```javascript
// src/physics/resistance.js
export function getDynamicResistance(baseR, currentFlowLps, currentVolL, pathology) {
  // Rohrers equation + volume-dependent airway tethering
  // Pathology-specific modifiers (COPD, ARDS, etc)
  return effectiveR;
}

// src/physics/compliance.js
export function getDynamicCompliance(currentTotalVolL, baseCml, pathology, phase, lungCapacityL) {
  // Lower Inflection Point (recruitment)
  // Upper Inflection Point (overdistension/balloon effect)
  // Hysteresis (inspiration vs expiration)
  return effectiveC;
}

// src/physics/gasExchange.js
export function calculateOxygenation(basePmean, baseCO2, fiO2, baseShunt, baseDeadspace, rr, vt) {
  // SpO2, EtCO2, effective shunt calculation
  return { SpO2, EtCO2, effectiveShunt };
}

// src/physics/pathologyPresets.js
export const PATHOLOGY_PRESETS = {
  NORMAL: { ... },
  ARDS: { ... },
  COPD: { ... },
  EMPHYSEMA: { ... },
  // ... with clinical tips for each
};
```

**ใช้ในโค้ด:**
```javascript
// main.jsx
import { getDynamicResistance } from './physics/resistance';
import { getDynamicCompliance } from './physics/compliance';
import { PATHOLOGY_PRESETS } from './physics/pathologyPresets';

// In updatePhysics()
const CLdynamic = getDynamicCompliance(s.volL, p.compL, p.pathology, s.phase, p.lungCapacity);
const { RL, RR } = getDualLungResistance(...);
```

**ข้อดี:**
- 📦 นำ modules ไปใช้ในโปรเจกต์อื่นได้
- 🧪 เทส physics แยกด้วย Jest/Vitest
- 📚 Reference documentation ชัดเจน
- 🔧 แก้ bug หรือปรับค่า ไม่ต้องกลัวทำลาย main.jsx

---

### 2️⃣ ระบบ Tooltip/Info (`src/content/tooltips.js` + `src/components/InfoTooltip.jsx`)

#### ก่อนหน้า ❌
- ไม่มี explanation บนผู้ใช้งานต้องรู้ข้อมูลเอง
- Note ใน PATHOLOGY_PRESETS แต่ไม่เชื่อมกับ UI

#### ตอนนี้ ✅
```javascript
// src/content/tooltips.js - Centralized Content
export const TOOLTIP_CONTENT = {
  en: {
    parameters: {
      Cstat: {
        title: 'Static Compliance (Cstat)',
        description: 'ΔV / ΔP: Volume change per unit pressure...',
        normal: '40-50 ml/cmH2O',
        ARDS: '15-25 ml/cmH2O (stiff lungs)',
        formula: '(Vt) / (Pplat - PEEP)'
      },
      AutoPEEP: {
        title: 'Intrinsic PEEP (Auto-PEEP)',
        description: 'Air trapping: alveoli still pressurized at end-expiration...',
        cause: 'Increased expiratory resistance, decreased expiratory time',
        danger: 'Reduces driving pressure; increases work of breathing'
      },
      // ... 20+ parameters with clinical context
    },
    pathologies: {
      ARDS: {
        title: 'ARDS - Acute Respiratory Distress Syndrome',
        mechanics: 'Stiff lungs (low C), baby lung pattern, high shunt',
        ventStrategy: 'Low Vt (6-8 ml/kg), high PEEP, low Pplat'
      }
      // ...
    }
  },
  th: {
    // Thai translations
  }
};
```

```jsx
// src/components/InfoTooltip.jsx
<InfoTooltip 
  title="ARDS" 
  description={PATHOLOGY_PRESETS.ARDS.note}
  position="top"
/>

// Use in UI:
<span>
  Cstat 
  <InfoTooltip 
    title="Cstat"
    description={getTooltip('Cstat', language)?.description}
  />
</span>
```

**ใช้ในโค้ด:**
```jsx
// main.jsx
const [language, setLanguage] = useState('en');

<div>
  <span className="text-gray-600">
    P-Plateau 
    <InfoTooltip 
      title="Pplat"
      description={getTooltip('Pplat', language)?.description}
      position="right"
    />
  </span>
  <span className="font-bold text-red-600">
    {monitoredValues.Pplat.toFixed(1)} cmH2O
  </span>
</div>

// Language Toggle
<button onClick={() => setLanguage('en')}>EN</button>
<button onClick={() => setLanguage('th')}>ไทย</button>
```

**ข้อดี:**
- 🎓 ผู้ใช้ได้คำอธิบายทางคลินิก + ฟิสิกส์ inline
- 🌐 รองรับ 2 ภาษา (ขยายได้ง่าย)
- 📌 Hover/Click mode ทั้งสองได้
- 🎨 Styled tooltips พร้อมตำแหน่ง (top/bottom/left/right)

---

### 3️⃣ Responsive UI Design (Desktop / Tablet / Mobile)

#### ก่อนหน้า ❌
- Fixed layout grid - นั่งไม่สวยบนมือถือ
- ข้อมูลหนาแน่น ไม่มีการซ่อน/แยกแท็บ

#### ตอนนี้ ✅

**Desktop (lg: 1024px+)**
```jsx
<div className="grid grid-cols-12 gap-6">
  <div className="col-span-8">
    {/* Waveforms + Loops (left) */}
    <WaveformsPanel />
    <LoopsPanel />
  </div>
  <div className="col-span-4">
    {/* Controls + Monitors (right) */}
    <ControlsPanel />
    <MonitoringPanel />
  </div>
</div>
```

**Tablet (md: 768px+)**
```jsx
// Same 2-column layout แต่กำหนด width ที่เหมาะสม
// Canvas height: h-32 → responsive
// Graphs stack ถ้าจำเป็น
```

**Mobile (< 768px)**
```jsx
<div className="hidden md:block">
  {/* Desktop Layout */}
</div>

<div className="md:hidden">
  {/* Tab Navigation */}
  <div className="flex gap-2 border-b">
    <button className="px-4 py-2 border-b-2">📈 Waves</button>
    <button className="px-4 py-2 border-b-2">🔄 Loops</button>
    <button className="px-4 py-2 border-b-2">📊 Monitors</button>
    <button className="px-4 py-2 border-b-2">⚙️ Settings</button>
  </div>

  {/* Tab Content - One at a time */}
  {activeMobileTab === 'waveforms' && <WaveformsPanel />}
  {activeMobileTab === 'loops' && <LoopsPanel />}
  {activeMobileTab === 'monitors' && <MonitoringPanel />}
  {activeMobileTab === 'settings' && <ControlsPanel />}

  {/* Sticky Bottom Bar */}
  <div className="fixed bottom-0 left-0 right-0 bg-white border-t p-3">
    <button className="flex-1">START/PAUSE</button>
    <button className="flex-1">STUDY MODE</button>
  </div>
</div>
```

**Breakpoints ที่ใช้:**
- `sm`: 640px (small phone)
- `md`: 768px (tablet) ← Key breakpoint
- `lg`: 1024px (desktop)
- `xl`: 1280px (large desktop)

**Tailwind Classes:**
```jsx
// Hide on mobile, show on md+
className="hidden md:block"

// Show on mobile, hide on md+
className="md:hidden"

// Different sizes per breakpoint
className="h-24 sm:h-28 md:h-32 lg:h-40"

// Grid changes
className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
```

**ข้อดี:**
- 📱 Same codebase, 3 different layouts
- 👆 Touch-friendly buttons (48px+ on mobile)
- 📊 Fullscreen graphs ไม่วุ่นวาย
- ⌨️ Settings tab easy to access

---

### 4️⃣ Study Mode - Fullscreen Graph View

#### ก่อนหน้า ❌
- ถ้าจะสอนต้องกลับไปมา ระหว่าง setting กับ graph
- กราฟเล็กๆ ไม่เหมาะสำหรับ projection

#### ตอนนี้ ✅
```jsx
// State
const [isStudyMode, setIsStudyMode] = useState(false);

// In UI - Add button in header
<button
  onClick={() => setIsStudyMode(true)}
  className="bg-green-600 text-white px-4 py-2 rounded"
>
  📊 Study Mode
</button>

// Render GraphOnlyView overlay
{isStudyMode && (
  <GraphOnlyView
    isActive={isStudyMode}
    onClose={() => setIsStudyMode(false)}
    canvasRefs={{ P: canvasRefP, F: canvasRefF, V: canvasRefV, PV: canvasRefPV, FV: canvasRefFV }}
    scales={scales}
    monitoredValues={monitoredValues}
    params={params}
  />
)}
```

**Study Mode Layout:**
```
┌─────────────────────────────────────────────┐
│ 📊 Study Mode │ MODE: PCV | PATHOLOGY: ARDS │ Snapshot │ Exit │
├──────────────────────────────┬──────────────┤
│                              │              │
│  Pressure Waveform (large)   │ P-V Loop     │
│                              │ (large)      │
├──────────────────────────────┤              │
│                              │              │
│  Flow Waveform (large)       │              │
│                              │              │
├──────────────────────────────┼──────────────┤
│                              │              │
│  Volume Waveform (large)     │ F-V Loop     │
│                              │ (large)      │
└──────────────────────────────┴──────────────┘
```

**Features:**
- ✅ Fullscreen black background (cinema mode)
- ✅ All 5 graphs ขยายใหญ่
- ✅ ยังใช้ simulation state เดียว (not duplicated)
- ✅ Snapshot button เก็บ screenshots
- ✅ Exit button กลับไปที่ normal mode

**Advantages:**
- 🎥 Perfect for teaching/presentation
- 🖥️ Display on projector/large screen
- 📸 Capture key moments (screenshots)
- ⚙️ Still control simulation while in study mode

---

## 🚀 How to Implement

### Step 1: Copy Files
```bash
# Physics modules
cp physics-resistance.js src/physics/resistance.js
cp physics-compliance.js src/physics/compliance.js
cp physics-gasExchange.js src/physics/gasExchange.js
cp physics-pathologyPresets.js src/physics/pathologyPresets.js

# Content
cp content-tooltips.js src/content/tooltips.js

# Components
cp component-InfoTooltip.jsx src/components/InfoTooltip.jsx
cp component-GraphOnlyView.jsx src/components/GraphOnlyView.jsx

# Main app (replace old main.jsx)
cp main-refactored-structure.jsx src/main.jsx
```

### Step 2: Install Dependencies (if needed)
```bash
npm install lucide-react  # Icons (already used)
```

### Step 3: Update main.jsx
Replace all the physics code with imports and use the new components.

### Step 4: Test
```bash
npm run dev
```

---

## 🎓 Educational Features

### For Teachers:
1. **Pathology Comparison** - Switch between NORMAL/ARDS/COPD instantly
2. **Study Mode** - Show fullscreen graphs on projector
3. **Multilingual** - EN/TH support
4. **Clinical Tips** - Each pathology includes ventilation strategy

### For Students:
1. **Tooltips on Hover** - Learn what each parameter means
2. **PV/FV Loops** - See relationship between pressure, volume, flow
3. **Real-time Monitoring** - Watch how settings affect SpO2, EtCO2
4. **Case Studies** - Preset pathologies to understand disease mechanics

---

## 📖 Quick Reference

### Accessing Physics Functions
```javascript
import { getDynamicResistance } from './physics/resistance';
const R = getDynamicResistance(baseR, flow, volume, 'COPD');
```

### Getting Tooltips
```javascript
import { getTooltip } from './content/tooltips';
const tip = getTooltip('Cstat', 'en'); // Returns { title, description, ... }
```

### Using InfoTooltip
```jsx
<InfoTooltip 
  title="Plateau Pressure"
  description="Paw at end-inspiration with no flow"
  position="right"
/>
```

### Study Mode
```jsx
const [isStudyMode, setIsStudyMode] = useState(false);

<button onClick={() => setIsStudyMode(true)}>Study Mode</button>

{isStudyMode && <GraphOnlyView isActive={true} onClose={() => setIsStudyMode(false)} ... />}
```

---

## 🔄 Future Improvements

- [ ] Extract layout components to separate files
- [ ] Add unit tests for physics modules
- [ ] Support for more languages (FR, ES, etc)
- [ ] Export data to CSV (for research)
- [ ] Record and replay simulations
- [ ] Dark/Light theme toggle
- [ ] Keyboard shortcuts (e.g., Space to play/pause)
- [ ] Mobile app version (React Native)

---

## 📝 Notes

- ทุกไฟล์ที่สร้างมาใหม่ commented ชัดเจน
- Physics functions ทั้งหมด pure functions (no side effects)
- Tooltip content centralized - ลง string แล้ว reuse everywhere
- Responsive design ใช้ Tailwind - ไม่ต้อง custom CSS

Happy Teaching! 🎓
