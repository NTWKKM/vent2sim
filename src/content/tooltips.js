/**
 * Tooltip and Info Content
 * Centralized content management for UI tooltips and educational info
 * Supports multilingual (Thai/English)
 */

export const TOOLTIP_CONTENT = {
  // English tooltips
  en: {
    // Ventilator Modes
    modes: {
      VCV: {
        title: 'Volume Control (VCV)',
        description: 'Delivers fixed tidal volume. Pressure varies with resistance and compliance. Used for controlled ventilation.',
        clinical: 'Best for: paralyzed patients, controlled sedation'
      },
      PCV: {
        title: 'Pressure Control (PCV)',
        description: 'Delivers fixed pressure. Tidal volume varies with compliance. Gentler on lungs with stiff mechanics.',
        clinical: 'Best for: ARDS, restrictive diseases'
      },
      PSV: {
        title: 'Pressure Support (PSV)',
        description: 'Patient-triggered, machine-supported mode. Patient controls rate; machine delivers set pressure above PEEP.',
        clinical: 'Best for: spontaneously breathing, weaning from ventilation'
      }
    },

    // Monitored Parameters
    parameters: {
      Pplat: {
        title: 'Plateau Pressure (Pplat)',
        description: 'Pressure at end-inspiration with no flow. Reflects lung stiffness and volume status.',
        normal: '<25 cmH2O',
        danger: '>30 cmH2O indicates overdistension',
        formula: 'Measured during inspiratory hold maneuver'
      },
      Pmean: {
        title: 'Mean Airway Pressure (Pmean)',
        description: 'Average pressure throughout breath cycle. Higher Pmean = better oxygenation but more hemodynamic impact.',
        effect: 'Increasing I:E ratio or PEEP raises Pmean',
        caution: 'Can reduce cardiac output if too high'
      },
      Cstat: {
        title: 'Static Compliance (Cstat)',
        description: 'ΔV / ΔP: Volume change per unit pressure with no flow. Reflects true lung elasticity.',
        normal: '40-50 ml/cmH2O',
        ARDS: '15-25 ml/cmH2O (stiff lungs)',
        formula: '(Vt) / (Pplat - PEEP)'
      },
      AutoPEEP: {
        title: 'Intrinsic PEEP (Auto-PEEP)',
        description: 'Air trapping: alveoli still pressurized at end-expiration. Common in COPD and with short expiratory time.',
        cause: 'Increased expiratory resistance, decreased expiratory time',
        danger: 'Reduces driving pressure; increases work of breathing; causes asynchrony',
        measurement: 'End-expiratory occlusion maneuver'
      },
      TotalRR: {
        title: 'Total Respiratory Rate',
        description: 'Machine breaths + patient-triggered breaths. Important in PSV mode.',
        high: 'High rate (>30) may indicate patient distress or fighting ventilator',
        low: 'Low rate may indicate apnea or inadequate trigger sensitivity'
      },
      MV: {
        title: 'Minute Ventilation (MV)',
        description: 'Total volume exhaled per minute. Reflects CO2 clearance.',
        normal: '5-8 L/min',
        low: 'May cause CO2 retention (hypercapnia)',
        high: 'May cause respiratory alkalosis'
      },
      VtExp: {
        title: 'Exhaled Tidal Volume (VtExp)',
        description: 'Actual volume exhaled. May differ from set volume in VCV due to airway leak.',
        target: 'Should match set volume within 10%',
        warning: 'Large difference indicates ETT leak or circuit disconnect'
      },
      VPeak: {
        title: 'Peak Volume',
        description: 'Maximum lung volume achieved during breath. Indicates degree of inflation.',
        relationship: 'Peak Volume = PEEP volume + exhaled Vt'
      },
      SpO2: {
        title: 'Oxygen Saturation (SpO2)',
        description: 'Estimated oxygen saturation based on FiO2, PEEP, and shunt fraction.',
        target: '>92% for most patients',
        danger: '<90% indicates significant hypoxemia'
      },
      EtCO2: {
        title: 'End-tidal CO2 (EtCO2)',
        description: 'Estimated CO2 concentration. Higher = poor ventilation.',
        normal: '35-45 mmHg',
        high: 'Indicates hypoventilation or increased CO2 production',
        low: 'Indicates hyperventilation or increased dead space'
      },
      DrivingPressure: {
        title: 'Driving Pressure',
        description: 'Pplat - PEEP. The pressure actually inflating the lungs.',
        safe: '<15 cmH2O preferred',
        high: 'High driving pressure increases risk of volutrauma',
        formula: '(Pplat - PEEP) = Driving Pressure'
      }
    },

    // Pathologies
    pathologies: {
      ARDS: {
        title: 'ARDS - Acute Respiratory Distress Syndrome',
        description: 'Severe lung inflammation with diffuse alveolar damage.',
        mechanics: 'Stiff lungs (low C), baby lung pattern, high shunt',
        ventStrategy: 'Low Vt (6-8 ml/kg), high PEEP, low Pplat',
        prognosis: 'Mortality 20-45% depending on severity'
      },
      COPD: {
        title: 'COPD - Chronic Obstructive Pulmonary Disease',
        description: 'Progressive obstruction with air trapping and hyperinflation.',
        mechanics: 'High compliance, high resistance, increased FRC',
        ventStrategy: 'Long expiratory times, lower rates (8-10), careful PEEP',
        caution: 'Risk of auto-PEEP and hemodynamic compromise'
      },
      Emphysema: {
        title: 'Emphysema - Advanced COPD',
        description: 'Destruction of alveolar walls with severe hyperinflation.',
        mechanics: 'Very high compliance, severe air trapping',
        ventStrategy: 'Extreme caution: patient likely at 70-80% TLC at rest',
        danger: 'High risk of dynamic hyperinflation and cardiovascular collapse'
      },
      FIBROSIS: {
        title: 'Pulmonary Fibrosis',
        description: 'Progressive stiffening of lung tissue.',
        mechanics: 'Very low compliance, limited recruitment potential',
        ventStrategy: 'Similar to ARDS: low Vt, accept high driving pressures'
      }
    },

    // Settings
    settings: {
      RR: {
        title: 'Respiratory Rate',
        description: 'Machine-set breaths per minute.',
        normal: '12-16 breaths/min',
        high: 'Higher rates increase mean airway pressure but risk tachypnea',
        low: 'Lower rates improve oxygenation but may reduce ventilation'
      },
      Ti: {
        title: 'Inspiratory Time',
        description: 'Duration of inhalation. Longer Ti = higher mean airway pressure.',
        normal: '0.8-1.2 seconds',
        effect: 'Increasing Ti increases I:E ratio and Pmean',
        risk: 'Very long Ti (>1.5s) may reduce CO2 clearance'
      },
      PEEP: {
        title: 'Positive End-Expiratory Pressure',
        description: 'Pressure maintained at end of expiration.',
        normal: '5 cmH2O',
        ARDS: '8-15 cmH2O',
        COPD: '0-3 cmH2O (avoid adding to auto-PEEP)',
        benefit: 'Recruits collapsed alveoli, improves oxygenation'
      },
      FiO2: {
        title: 'Inspired Oxygen Fraction',
        description: 'Percentage of oxygen in inspired gas.',
        normal: '21% (room air)',
        target: 'Titrate to SpO2 92-95%',
        caution: 'High FiO2 (>60%) risk of absorption atelectasis'
      }
    },

    // Study Tips
    tips: {
      studying: 'Try adjusting one parameter at a time to see its effect',
      loops: 'Watch the P-V and F-V loops change shape with different settings',
      waveforms: 'Look for plateau phase (end-inspiration) to estimate Pplat',
      pathology: 'Each pathology shows different compliance and resistance patterns',
      clinical: 'Correlate simulator findings with real clinical scenarios'
    }
  },

  // Thai tooltips
  th: {
    modes: {
      VCV: {
        title: 'Volume Control (VCV)',
        description: 'ให้ปริมาณแก๊สคงที่ ความดันแปรตามการต้านทานและความ compliant',
        clinical: 'ใช้กับ: ผู้ป่วยไม่ยึด, sedation เต็มที่'
      },
      PCV: {
        title: 'Pressure Control (PCV)',
        description: 'ให้ความดันคงที่ ปริมาณแก๊สแปรตามความ compliant',
        clinical: 'ใช้กับ: ARDS, โรคจำกัดการขยาย'
      },
      PSV: {
        title: 'Pressure Support (PSV)',
        description: 'ผู้ป่วยนำ, ปั๊มช่วย ผู้ป่วยควบคุมอัตรา',
        clinical: 'ใช้กับ: การหายใจเองและ weaning'
      }
    },
    parameters: {
      Pplat: {
        title: 'ความดัน Plateau',
        description: 'ความดันที่สิ้นสุดการหายใจเข้า ไม่มีการไหลอากาศ',
        normal: '<25 cmH2O',
        danger: '>30 cmH2O บ่งบอกการ overdistension'
      },
      Cstat: {
        title: 'Compliance สถิต',
        description: 'ปริมาณการเปลี่ยนแปลงต่อหน่วยความดัน (ΔV / ΔP)',
        normal: '40-50 ml/cmH2O',
        ARDS: '15-25 ml/cmH2O (ปอดแข็ง)'
      },
      AutoPEEP: {
        title: 'Auto-PEEP (Intrinsic PEEP)',
        description: 'การติดอากาศ: ถุงลมยังมีความดันที่สิ้นสุดการหายใจออก',
        cause: 'ความต้านทานสูง เวลาหายใจออกสั้น',
        danger: 'ลดแรงขับ ทำให้ผู้ป่วยเหนื่อย'
      }
    }
  }
};

/**
 * Get tooltip content by parameter name and language
 */
export function getTooltip(paramName, language = 'en') {
  const content = TOOLTIP_CONTENT[language] || TOOLTIP_CONTENT['en'];
  
  // Search through all categories
  for (const category in content) {
    if (content[category][paramName]) {
      return content[category][paramName];
    }
  }
  
  return null;
}

/**
 * Get all tooltip content for a category
 */
export function getCategoryTooltips(category, language = 'en') {
  const content = TOOLTIP_CONTENT[language] || TOOLTIP_CONTENT['en'];
  return content[category] || {};
}
