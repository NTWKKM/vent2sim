/**
 * Airway Resistance Physics Module
 * Based on Rohrers Equation with flow dependence and volume tethering
 * Reference: 5.Resistance-of-the-respiratory-system.pdf
 */

export function getDynamicResistance(baseR, currentFlowLps, currentVolL, pathology) {
  /**
   * Resistance calculation incorporating:
   * 1. Flow Dependence (Rohrers equation) - turbulence increases with flow
   * 2. Volume Dependence (Airway Tethering) - airway diameter changes with volume
   * 
   * @param {number} baseR - Base resistance (cmH2O·s/L)
   * @param {number} currentFlowLps - Flow in L/s (can be negative)
   * @param {number} currentVolL - Lung volume in L
   * @param {string} pathology - Patient pathology (NORMAL, COPD, ARDS, etc)
   * @returns {number} Effective resistance (cmH2O·s/L)
   */

  // 1. Flow Dependence - Rohrers Equation Component K2*Flow
  let turbulenceFactor = 0.5; // K2 coefficient

  // 2. Volume Dependence - Airway Tethering (elastic recoil effect)
  let volumeFactor = 2.0;

  // Pathology-specific resistance modifiers
  if (pathology === 'COPD' || pathology === 'EMPHYSEMA') {
    // Emphysema: high turbulence due to bronchiolar collapse
    turbulenceFactor = 2.5; // More turbulent flow
    volumeFactor = 5.0; // Greater volume effect due to loss of elastic tissue
  }

  if (pathology === 'ARDS') {
    // ARDS: reduced airway diameter due to edema/inflammation
    turbulenceFactor = 1.2;
    volumeFactor = 1.5;
  }

  // Calculate flow effect (hyperbolic decay with volume)
  const flowEffect = Math.abs(currentFlowLps) * turbulenceFactor;

  // Calculate volume effect (reduced airway caliber at lower volumes)
  const volEffect = Math.min(baseR * 0.6, currentVolL * volumeFactor);

  // Combine effects
  let effectiveR = baseR + flowEffect - volEffect;

  // Safety clamping - resist negative values and extreme highs
  effectiveR = Math.max(baseR * 0.3, Math.min(effectiveR, 30));

  return effectiveR;
}

/**
 * Calculate resistance for both lungs independently
 * Useful for asymmetric lung conditions
 */
export function getDualLungResistance(baseRL, baseRR, flowL, flowR, volL, volR, pathology) {
  const RL = getDynamicResistance(baseRL, flowL, volL, pathology);
  const RR = getDynamicResistance(baseRR, flowR, volR, pathology);
  return { RL, RR };
}
