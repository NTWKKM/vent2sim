/**
 * Gas Exchange and Oxygenation Physics Module
 * Simplified model based on:
 * - Shunt effect (V/Q mismatch)
 * - Alveolar dead space (wasted ventilation)
 * - Mean airway pressure effect on oxygenation
 */

export function calculateOxygenation(basePmean, baseCO2, fiO2, baseShunt, baseDeadspace, respiratoryRate, vt_L) {
  /**
   * Estimate SpO2 based on ventilation, oxygenation, and shunt
   *
   * @param {number} basePmean - Mean airway pressure (cmH2O)
   * @param {number} baseCO2 - Baseline CO2 elimination
   * @param {number} fiO2 - Inspired oxygen fraction (0.21-1.0)
   * @param {number} baseShunt - Baseline shunt fraction (0-1.0)
   * @param {number} baseDeadspace - Baseline dead space fraction (0-1.0)
   * @param {number} respiratoryRate - Breaths per minute
   * @param {number} vt_L - Tidal volume (L)
   * @returns {object} { SpO2, EtCO2, effectiveShunt }
   */

  // Mean airway pressure improves oxygenation by recruiting atelectatic alveoli
  // Effect saturates at higher Pmean
  const PmeanEffect = Math.max(0, (basePmean - 5) * 0.01); // Each cmH2O above 5 has effect
  let actualShunt = Math.max(0.01, baseShunt - PmeanEffect);

  // SpO2 calculation
  // Simplified: lower shunt + higher FiO2 → higher SpO2
  let estimatedSpO2 = 99 - (actualShunt * 100 * 1.5);
  
  // FiO2 effect: higher oxygen helps overcome shunt
  const fio2EffectFactor = (fiO2 - 0.40) * 15; // Calibrated to room air baseline
  estimatedSpO2 += fio2EffectFactor;

  // Clamp SpO2 between physiologic limits
  estimatedSpO2 = Math.max(50, Math.min(100, estimatedSpO2));

  // --- EtCO2 Calculation ---
  // Effective minute ventilation (accounting for dead space)
  const MVe = respiratoryRate * vt_L * (1 - baseDeadspace); // Alveolar ventilation only
  const idealMV = 6.0; // L/min at rest
  
  // EtCO2 inversely proportional to ventilation
  let estimatedEtCO2 = 40 * (idealMV / Math.max(0.1, MVe));
  
  // Clamp EtCO2
  estimatedEtCO2 = Math.max(10, Math.min(100, estimatedEtCO2));

  return {
    SpO2: Math.round(estimatedSpO2),
    EtCO2: Math.round(estimatedEtCO2),
    effectiveShunt: actualShunt,
    effectiveMV: MVe
  };
}

/**
 * Calculate PaO2 using simplified alveolar gas equation
 * A-a Gradient ≈ shunt effect + V/Q mismatch
 */
export function calculatePaO2(FiO2, Pmean, PvO2 = 40, shunt = 0.05) {
  // Simplified: PAO2 improved by higher FiO2 and mean airway pressure
  const PAO2_effect = (FiO2 * 700) + (Pmean - 5) * 0.5;
  
  // A-a gradient due to shunt
  const AaDiff = shunt * 600; // Severe shunt can create 300-600 mmHg gradient
  
  // Approximate PaO2
  const PaO2 = PAO2_effect - AaDiff;
  
  return Math.max(30, Math.min(600, PaO2));
}

/**
 * Calculate arterial blood gas estimates
 */
export function calculateBloodGas(SpO2, EtCO2, pH_baseline = 7.40) {
  // Simplified Severinghaus equation for PaCO2 from EtCO2
  // EtCO2 typically 2-5 mmHg below PaCO2 due to dead space
  const PaCO2 = EtCO2 + 3;

  // pH from PaCO2 (Henderson-Hasselbalch simplified)
  // Each 10 mmHg increase in CO2 decreases pH by ~0.08
  const pH = pH_baseline - ((PaCO2 - 40) * 0.008);

  // PaO2 from SpO2 using oxygen dissociation curve approximation
  // Steep slope between 90-100 SpO2, shallow below 90
  let PaO2;
  if (SpO2 >= 95) {
    PaO2 = 60 + (SpO2 - 90) * 4; // 95% SpO2 ≈ 100 PaO2
  } else if (SpO2 >= 90) {
    PaO2 = 60 + (SpO2 - 90) * 1; // 90% SpO2 ≈ 60 PaO2
  } else {
    PaO2 = 45 * (SpO2 / 80); // Below 90: steep drop
  }

  return {
    PaO2: Math.round(PaO2),
    PaCO2: Math.round(PaCO2),
    pH: pH.toFixed(2),
    HCO3: 24 // Simplified: assume normal bicarbonate
  };
}
