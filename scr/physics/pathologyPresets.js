/**
 * Pathology Presets Database
 * Each preset defines the mechanical characteristics of different lung pathologies
 * with clinical notes explaining the expected behavior
 */

export const PATHOLOGY_PRESETS = {
  NORMAL: {
    name: 'Normal Adult on ETT',
    resL: 15,
    compL: 50,
    resR: 15,
    compR: 50,
    shunt: 0.05,        // 5% normal shunt
    deadspace: 0.15,    // 15% alveolar dead space
    frcOffset: 0.0,     // No air trapping
    lungCapacity: 3.0,  // Total lung capacity 3L
    note: 'Normal mechanics. Symmetrical lungs. Standard adult on ETT. Normal PV curve.',
    clinicalTips: [
      'Baseline compliance ~50 ml/cmH2O per lung',
      'Normal PEEP 5 cmH2O sufficient',
      'SpO2 should improve with modest FiO2 increase',
      'Auto-PEEP minimal with normal expiration time'
    ]
  },

  ARDS: {
    name: 'ARDS - Stiff Lungs',
    resL: 15,
    compL: 30,          // Reduced compliance
    resR: 15,
    compR: 30,
    shunt: 0.30,        // 30% shunt (atelectasis + V/Q mismatch)
    deadspace: 0.35,    // 35% dead space
    frcOffset: 0.0,     // No hyperinflation
    lungCapacity: 1.0,  // Baby lung (~1L usable capacity)
    note: 'ARDS "Baby Lung" pattern. Low compliance. High shunt. Early overdistension.',
    clinicalTips: [
      'Lung recruitment maneuver may help (30 cmH2O × 30s)',
      'Lower tidal volumes (6-8 ml/kg) to avoid volutrauma',
      'Higher PEEP (8-15 cmH2O) needed for recruitment',
      'SpO2 drops easily if PEEP reduces or mode changes',
      'Watch for overdistension at high pressures (>30 cmH2O)',
      'Expect high driving pressure; improve with lower Vt'
    ]
  },

  COPD: {
    name: 'COPD - Mild/Moderate',
    resL: 20,           // Slightly increased resistance
    compL: 60,          // Increased compliance (loss of elastic recoil)
    resR: 20,
    compR: 60,
    shunt: 0.10,        // 10% shunt
    deadspace: 0.30,    // 30% dead space
    frcOffset: 1.0,     // Mild hyperinflation (FRC offset 1L above normal)
    lungCapacity: 3.5,  // Increased TLC
    note: 'Moderate air trapping. Increased R and C. Can exhale fully at low RR.',
    clinicalTips: [
      'Higher compliance - use lower pressures',
      'Increased resistance - allow longer expiration (I:E 1:3-1:4)',
      'Risk of auto-PEEP with rapid rates; watch volume plateau',
      'Spontaneous breathing helps; consider PSV mode',
      'Peak flow may be misleading due to expiratory limitation',
      'FRC already elevated by ~1L; PEEP should be lower (3-5 cmH2O)'
    ]
  },

  EMPHYSEMA: {
    name: 'Emphysema - Severe',
    resL: 25,           // High resistance
    compL: 120,         // Very high compliance (floppy lungs)
    resR: 25,
    compR: 120,
    shunt: 0.15,
    deadspace: 0.45,    // 45% dead space (high)
    frcOffset: 2.3,     // Severe hyperinflation (FRC offset 2.3L)
    lungCapacity: 3.0,  // Inverted ratio: more FRC, less breathing room
    note: 'Severe hyperinflation. Severe air trapping. Starts near full TLC.',
    clinicalTips: [
      'DANGER: Patient already at ~75% TLC at rest',
      'Tidal volume will be LOW despite high compliance',
      'Extreme risk of auto-PEEP and hemodynamic compromise',
      'Use VERY long expiratory times (I:E 1:5+) or accept breath stacking',
      'Lower PEEP essential - extrinsic PEEP worsens hyperinflation',
      'Consider inverse ratio if needed, but monitor MAP carefully',
      'Permissive hypercapnia may be safest approach',
      'Watch for paradoxical abdominal breathing patterns'
    ]
  },

  PULMONARYEDEMA: {
    name: 'Pulmonary Edema',
    resL: 15,
    compL: 25,          // Very low compliance (fluid)
    resR: 15,
    compR: 25,
    shunt: 0.25,        // 25% shunt (fluid consolidation)
    deadspace: 0.25,
    frcOffset: 0.0,
    lungCapacity: 2.0,  // Reduced usable capacity
    note: 'Fluid in lungs reducing compliance. Similar to mild ARDS.',
    clinicalTips: [
      'Treat underlying cause (diuretics for CHF, etc.)',
      'Increased PEEP helps (5-8 cmH2O) to push fluid out of alveoli',
      'Monitor for V/Q worsening if too much PEEP',
      'May improve rapidly once diuresed or treated'
    ]
  },

  UNILATERALCDEC: {
    name: 'Unilateral Low C - Right',
    resL: 15,
    compL: 50,          // Left lung normal
    resR: 15,
    compR: 20,          // Right lung stiff
    shunt: 0.15,
    deadspace: 0.20,
    frcOffset: 0.0,
    lungCapacity: 2.5,
    note: 'Right lung collapse/consolidation. Flow preferentially to left.',
    clinicalTips: [
      'Unequal breath sounds on auscultation',
      'May need higher driving pressure to ventilate stiff right lung',
      'Risk of preferential left lung overdistension',
      'Consider position changes (right lateral decubitus) to improve right V/Q',
      'May need independent lung ventilation if severe'
    ]
  },

  PULMONARYFIB: {
    name: 'Pulmonary Fibrosis',
    resL: 15,
    compL: 20,          // Very low compliance
    resR: 15,
    compR: 20,
    shunt: 0.08,
    deadspace: 0.20,
    frcOffset: 0.0,
    lungCapacity: 1.5,  // Reduced TLC
    note: 'Restrictive disease. Stiff lungs. Progressive desaturation.',
    clinicalTips: [
      'Similar to ARDS in mechanics, but slower progression',
      'Very low compliance requires lower volumes and higher pressures',
      'Watch for progressive V/Q mismatch over time',
      'Limited ability to recruit; focus on PEEP optimization'
    ]
  },

  CUSTOM: {
    name: 'Custom Settings',
    resL: 15,
    compL: 50,
    resR: 15,
    compR: 50,
    shunt: 0.05,
    deadspace: 0.15,
    frcOffset: 0.0,
    lungCapacity: 3.0,
    note: 'Manual control. Adjust parameters for custom pathology.',
    clinicalTips: [
      'Use slider controls below to adjust resistance and compliance',
      'Test your own clinical scenarios',
      'Observe how each parameter affects waveforms and loops'
    ]
  }
};

/**
 * Get preset by name
 */
export function getPathologyPreset(pathologyName) {
  return PATHOLOGY_PRESETS[pathologyName] || PATHOLOGY_PRESETS.CUSTOM;
}

/**
 * Get all available pathologies as array (for dropdowns)
 */
export function getAvailablePathologies() {
  return Object.keys(PATHOLOGY_PRESETS).map(key => ({
    value: key,
    label: PATHOLOGY_PRESETS[key].name
  }));
}

/**
 * Get clinical tips for a pathology
 */
export function getPathologyClinicalTips(pathologyName) {
  const preset = PATHOLOGY_PRESETS[pathologyName];
  return preset?.clinicalTips || [];
}
