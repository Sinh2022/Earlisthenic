# Accessibility Statement for Earlisthenic

Earlisthenic is committed to ensuring digital accessibility for people with disabilities, audio professionals, music producers, and sound engineering students worldwide. We continually improve the user experience for everyone and apply relevant accessibility standards.

---

## 1. Conformance Status

Earlisthenic targets conformance with the **Web Content Accessibility Guidelines (WCAG) 2.1 Level AA** standards.

---

## 2. Key Accessibility Implementations

### A. Full Keyboard Navigation
- **Focus Indicators:** Clear, high-contrast visual focus rings (`ring-2 ring-[#B56D4E]`) surround all interactive elements.
- **Accessible Controls:** All 9 exercise games, transport buttons (Play/Stop, Loop, Trim, DAC mode), and interactive cards can be fully navigated and triggered via `Tab`, `Enter`, `Space`, and `Arrow` keys.
- **Logical Tab Order:** DOM ordering follows a natural, intuitive visual hierarchy without keyboard traps.

### B. Screen Reader & Assistive Technology Support
- **Semantic Structure:** Native HTML5 semantic elements (`<header>`, `<nav>`, `<main>`, `<article>`, `<section>`, `<footer role="contentinfo">`) structure the application layout.
- **ARIA Live Regions:** Live audio status updates, score feedback, and heart point counts are announced using `aria-live="polite"` regions.
- **Non-Visual Alternatives:** Complex graphics, such as the Six-Axis Radar Chart and dynamic audio spectrums, are paired with tabular numeric HUD readouts (`#radar-mini-meters-grid`) and accessible text summaries.

### C. Color Contrast & Visual Customization
- **Theme Support:** Fully tested across Dark, Light, and Washi Paper themes with text-to-background contrast ratios exceeding the minimum 4.5:1 requirement.
- **Independent Visual Cues:** Audio status changes and level results do not rely solely on color; they are always accompanied by textual labels, numerical decibel ratings, or distinct icon indicators.
- **Text Scaling:** Interface typography and layouts scale gracefully up to 200% zoom without layout breakage or overlapping controls.

### D. Acoustic & Hearing Protection
- **Acoustic Transients Guard:** Integrated peak limiters and smooth 10ms–18ms gain envelopes prevent sudden loud clicks or pops during filter switching.
- **Input Trim Attenuation:** Real-time software input trim slider allows continuous attenuation from -12 dB to +6 dB to maintain safe listening SPL.
- **Safe Mode Fallback:** Built-in studio reference loops synthesize calibrated, normalized audio buffers to prevent ear fatigue during prolonged technical ear training.

---

## 3. Supported Environments

Earlisthenic is tested for compatibility with:
- **Operating Systems:** Windows 10/11, macOS (Sonoma / Ventura), Linux (Ubuntu / Fedora), iOS / iPadOS, Android.
- **Web Browsers:** Google Chrome, Mozilla Firefox, Apple Safari, Microsoft Edge.
- **Screen Readers:** NVDA, JAWS, VoiceOver (macOS / iOS), TalkBack (Android).

---

## 4. Known Limitations & Alternatives

While we strive for comprehensive accessibility, certain real-time DSP visualizers have practical limitations:
- **Live Canvas Spectrum:** High-speed real-time FFT spectrum visualizers render at 60 FPS on HTML5 `<canvas>`. Screen reader users can rely on the live tabular peak meter readouts (`#lbl-peak-db`) and numeric answer badges which update synchronously.
- **Alternative Audio Paths:** For users sensitive to high-frequency tones, games involving ultra-high resonance notches or feedback frequencies (such as Feedback Eliminator) feature adjustable difficulty tiers and frequency range limits.

---

## 5. Feedback & Reporting Barriers

We welcome your feedback on the accessibility of Earlisthenic. If you encounter accessibility barriers, have suggestions for improvement, or need assistance, please contact us:

- **Email:** [4wards.music@gmail.com](mailto:4wards.music@gmail.com)
- **GitHub Issues:** [Earlisthenic Issue Tracker](https://github.com/Sinh2022/Earlisthenic/issues)
- **Response Time:** We aim to review and respond to accessibility feedback within 2 business days.

---

*Last updated: November 2026*
