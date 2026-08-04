// Chrome-only strings for the guided tour overlay (buttons, progress label, language toggle).
// Per-step title/body copy lives inline in tourSteps.js instead — see that file for why.
export const TOUR_STRINGS = {
  en: {
    next: 'Next',
    back: 'Back',
    skip: 'Skip',
    done: 'Done',
    stepOf: (i, n) => `Step ${i} of ${n}`,
    startTour: 'Start Guided Tour',
    languageToggle: 'ગુ',
    locating: 'Finding this on your screen…',
  },
  gu: {
    next: 'આગળ',
    back: 'પાછળ',
    skip: 'છોડી દો',
    done: 'પૂર્ણ',
    stepOf: (i, n) => `પગલું ${i} માંથી ${n}`,
    startTour: 'ગાઇડેડ ટૂર શરૂ કરો',
    languageToggle: 'EN',
    locating: 'સ્ક્રીન પર શોધી રહ્યાં છીએ…',
  },
};
