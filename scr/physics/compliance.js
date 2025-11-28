/**
 * Lung Compliance Physics Module
 * Non-linear compliance with hysteresis, recruitment, and overdistension
 * Reference: 2.Static-dynamic-and-specific-compliance.pdf, 3.Hysteresis-of-the-pulmonary-pressure-volume-curve.pdf
 */

export function getDynamicCompliance(currentTotalVolL, baseCml, pathology, phase, lungCapacityL) {
  /**
   * Calculate lung compliance accounting for:
   * 1. Lower Inflection Point (LIP) - recruitment phase
   * 2. Upper Inflection Point (UIP) - overdistension/balloon effect
   * 3. Phase-dependent hysteresis (inspiration vs expiration)
   * 4. Pathology-specific pressure-volume relationships
   *
   * @param {number} currentTotalVolL - Current lung volume (L)
   * @param {number} baseCml - Base compliance (ml/cmH2O)
   * @param {string} pathology - Patient condition
   * @param {string} phase - Current breath phase (INS, EXP, HOLDINS, HOLDEXP, REC)
   * @param {number} lungCapacityL - Total lung capacity (L)
   * @returns {number} Effective compliance (L/cmH2O)
   */

  const baseCL = (baseCml / 1000); // Convert ml/cmH2O to L/cmH2O

  // Define inflection points based on pathology
  let lowerInflectionL = 0.1;    // LIP volume (L)
  let upperInflectionL = lungCapacityL * 0.75; // UIP at 75% TLC
  let distensionFactor = 10;

  switch (pathology) {
    case 'ARDS':
      // ARDS: Small baby lung with low compliance and poor recruitment
      lowerInflectionL = 0.15;   // Higher LIP due to collapsed alveoli
      upperInflectionL = lungCapacityL * 0.6; // UIP drops early
      distensionFactor = 20;      // Steep overdistension penalty
      break;

    case 'PULMONARYEDEMA':
      // Pulmonary edema: Fluid-filled alveoli reduce both compliance and capacity
      lowerInflectionL = 0.08;
      upperInflectionL = lungCapacityL * 0.5;
      distensionFactor = 25;
      break;

    case 'FIBROSIS':
      // Pulmonary fibrosis: Stiff lungs with poor recruitment
      lowerInflectionL = 0.05;
      upperInflectionL = lungCapacityL * 0.5;
      distensionFactor = 25;      // Very stiff at high volumes
      break;

    case 'EMPHYSEMA':
    case 'COPD':
      // COPD/Emphysema: Loss of elastic tissue, early overdistension
      lowerInflectionL = 0.0;     // Minimal recruitment (already open)
      upperInflectionL = lungCapacityL * 0.8; // But less room to expand
      distensionFactor = 8;       // Gentler slope due to loss of elastic recoil
      break;

    default: // NORMAL
      lowerInflectionL = 0.1;
      upperInflectionL = lungCapacityL * 0.85;
      distensionFactor = 10;
  }

  let effectiveC = baseCL;

  // --- RECRUITMENT PHASE (Lower Inflection Point) ---
  // Below LIP: stiff compliance due to alveolar collapse + surface tension
  if (phase === 'INS' || phase === 'HOLDINS' || phase === 'REC') {
    if (currentTotalVolL < lowerInflectionL) {
      // Recruitment factor: increases compliance as alveoli open
      const factor = 0.5 + (0.5 * (currentTotalVolL / lowerInflectionL));
      effectiveC = baseCL * factor;
    }
  }

  // --- BALLOON EFFECT (Overdistension / Upper Inflection Point) ---
  // Above UIP: exponentially increasing stiffness due to:
  // - Tissue stretch (collagen fibers)
  // - Surface tension increase (decreased surfactant effect)
  if (currentTotalVolL > upperInflectionL) {
    const excessVol = currentTotalVolL - upperInflectionL;
    // Exponential decay: compliance drops exponentially as overdistension increases
    const stiffness = Math.exp(-excessVol * distensionFactor);
    effectiveC = baseCL * stiffness;
  }

  // --- HYSTERESIS (Phase-dependent behavior) ---
  // Expiration has slightly higher compliance due to:
  // - Surfactant re-concentration
  // - Elastic recoil doesn't dissipate as much energy
  if (phase === 'EXP' || phase === 'HOLDEXP') {
    effectiveC *= 1.05; // 5% improvement in expiratory compliance
  }

  // Safety: minimum compliance (2 ml/cmH2O = 0.002 L/cmH2O) to prevent division by zero
  return Math.max(0.002, effectiveC);
}

/**
 * Calculate dual-lung compliance with asymmetry support
 * For conditions affecting one lung more than the other (e.g., unilateral collapse)
 */
export function getDualLungCompliance(volL, volR, baseCompL, baseCompR, pathology, phase, lungCapacity) {
  const CL = getDynamicCompliance(volL, baseCompL, pathology, phase, lungCapacity);
  const CR = getDynamicCompliance(volR, baseCompR, pathology, phase, lungCapacity);
  return { CL, CR };
}

/**
 * Calculate specific compliance (normalized by FRC)
 * Useful for comparing lungs of different sizes
 * Reference: 2.Static-dynamic-and-specific-compliance.pdf
 */
export function getSpecificCompliance(totalComplianceMlPerCmH2O, FRCmL) {
  // Specific compliance = C_total / FRC
  // Units: (ml/cmH2O) / ml = 1/cmH2O = cmH2O^-1
  if (FRCmL <= 0) return 0;
  return totalComplianceMlPerCmH2O / FRCmL;
}
