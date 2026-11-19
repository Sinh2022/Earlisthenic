# Earlisthenic — Linear-Phase Audio Ear Training & Psychoacoustic Frequency Lab

[![Live Demo](https://img.shields.io/badge/Live-Demo-B56D4E?style=for-the-badge&logo=google-chrome&logoColor=white)](https://sinh2022.github.io/Earlisthenic/)
[![Version](https://img.shields.io/badge/Version-2.10.5-2D4436?style=for-the-badge)](https://sinh2022.github.io/Earlisthenic/)
[![License: MIT](https://img.shields.io/badge/License-MIT-416752?style=for-the-badge)](LICENSE)
[![Engine: Web Audio FIR](https://img.shields.io/badge/DSP-8191--Tap_FIR_Linear--Phase-8B4513?style=for-the-badge)](docs/EARLISTHENIC_CORE_ARCHITECTURE_SPECIFICATION.md)
[![Storage: Google Drive](https://img.shields.io/badge/Storage-Google_Drive-4285F4?style=for-the-badge&logo=googledrive&logoColor=white)](docs/EARLISTHENIC_CORE_ARCHITECTURE_SPECIFICATION.md)

**Earlisthenic** is a professional-grade technical ear training and psychoacoustic frequency calibration studio engineered specifically for audio engineers, mixing/mastering professionals, and sound designers. Unlike traditional music ear trainers that drill musical pitch or solfège, Earlisthenic trains your critical listening to identify frequency anomalies, filter slopes, dynamic compression, harmonic distortion, and spatial positioning under authentic studio acoustic conditions.

---

## 🌟 Key Architectural Features

### 1. Zero-Phase 8191-Tap FIR Convolver Engine
- **Time-Symmetric Odd-Tap Convolution:** Mathematical zero phase rotation across all frequencies, preserving transient attacks, punch, and stereo imaging without time-smearing or phase distortion.
- **Hann-Windowed Cosine Nulls:** Reaches authentic deep acoustic notches (> 60 dB attenuation) for surgical feedback elimination.
- **Safety Ceiling & Emergency Limiter:** Hard linear headroom trim (-3.5 dB) plus a transparent brickwall clamp (-0.2 dBFS) to protect studio monitoring gear and listener hearing.

### 2. High-Fidelity FREE AUDIO Engine & Seamless Streaming
- **Lossless FLAC Master Bitstreams:** Supports studio-grade 24-bit / 48 kHz – 192 kHz lossless audio files streaming directly from Google Drive.
- **Silent Background Pre-Cache:** Automatically pre-caches tracks into browser IndexedDB upon page load, ensuring instant (< 1ms) playback when entering exercises without stalling at buffering states.
- **10ms Equal-Power Crossfade Hot-Swap:** Smoothly transitions between studio reference stems and loaded high-resolution streams without acoustic clicks or pops.

### 3. Studio Mastery Hub & 6-Axis SPI Profile
- **Comprehensive 6-Axis Radar:** Visualizes mastery across Peaking, Low-End Bass, Filter Slopes, Stereo Pan, Speed Blitz, and Feedback Elimination.
- **Bidirectional Hover Linkage:** Hovering over radar mini-meters illuminates matching exercise cards in real-time, highlighting strengths and focus areas.
- **SoundGym Proficiency Index (SPI):** Psychoacoustic Scoring v4 tracks true skill progression with near-miss heart protection and habit-weighted consistency.

### 4. 9 Specialized Studio Disciplines
| Discipline | Focus Area | Acoustic Skill |
|---|---|---|
| **Peak Master** | EQ / Bell Boost & Cut | Critical frequency band detection (31 Hz – 16 kHz) |
| **Kit Cut** | Percussion EQ | Attenuating resonant ringing on drums & transients |
| **Bass Detective** | Sub-Bass Perception | Low-end clarity & phase alignment (40 Hz – 160 Hz) |
| **EQ Mirror** | Harmonic Symmetry | Matching complementary frequency adjustments |
| **EQ Knight** | Multi-Band Curves | Memorizing complex broadband spectral curves |
| **Filter Expert** | High-Pass / Low-Pass | Discerning filter slopes (6 dB, 12 dB, 18 dB, 24 dB/oct) |
| **Stereo Pan** | Spatial Listening | Localizing pan angles and stereo image boundaries |
| **EQ Cheetah** | Rapid Response | Speed-blitz frequency identification under time pressure |
| **Feedback Eliminator** | Live PA / ISO Bands | Instant notch targeting across 20 standard ISO bands |

---

## 🚀 Live Access & Deployment

Experience the live application deployed on GitHub Pages with Google Cloud / Apps Script edge infrastructure:

* **Production URL:** [https://sinh2022.github.io/Earlisthenic/](https://sinh2022.github.io/Earlisthenic/)
* **Google Apps Script Web App ID:** `AKfycbzLHk2-SsGIXKgbRgHj9PYpCH9niiBTj08RlaBAk6Bt0ywygJUKtXec2POug46DR8H5`

---

## 🛠 Project Structure

```text
Earlisthenic/
├── index.html                   # High-performance GitHub Pages gateway & Edge preconnect
├── README.md                    # Project documentation & overview
├── LICENSE                      # MIT Open Source License
├── CODE_OF_CONDUCT.md           # Contributor Covenant v2.1
├── CONTRIBUTING.md              # Community contribution & engineering guidelines
├── SECURITY.md                  # Security vulnerability reporting & isolation policy
├── ACCESSIBILITY.md             # WCAG 2.1 AA accessibility commitment & audio safeguards
├── .github/
│   ├── PULL_REQUEST_TEMPLATE.md # Structured pull request submission template
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md        # Bug & acoustic regression reporting template
│   │   ├── feature_request.md   # Feature & exercise proposal template
│   │   ├── audio_dsp_issue.md   # Specialized DSP & audio engine issue template
│   │   └── config.yml           # Community links & Discussions configuration
│   └── DISCUSSION_TEMPLATE/
│       ├── ideas.md             # Template for proposing new audio training ideas
│       ├── q-and-a.md           # Template for sound engineering & Q&A
│       └── announcements.md     # Engineering release notes & roadmap updates
└── docs/                        # Architectural specifications, audits & research reports
    ├── EARLISTHENIC_CORE_ARCHITECTURE_SPECIFICATION.md
    ├── EARLISTHENIC_BIG_UPDATE_ENGINEERING_REPORT.md
    ├── EARLISTHENIC_INSTANT_STREAM_AND_MASTERY_HUB_REPORT.md
    ├── psychoacoustic_scoring_system_design.md
    └── TEST_ORACLE_SPECIFICATION.md
```

---

## 🧪 Testing & Verification

Earlisthenic enforces strict quality gates across 4 comprehensive test suites:

```bash
# Run complete test verification pipeline
npm test

# Run individual test suites
node tests/syntax.test.js           # 27 syntax checks across scripts & partials
node tests/logic_invariants.test.js # 8 logic & UI invariants checks
node tests/run-tests.js             # 22 automated verification tests
node tests/e2e_dom.test.js          # 13 full-stack E2E DOM & audio mock checks
```

---

## 💬 Community & Discussions

We welcome feedback, acoustic feature ideas, and discussion from audio engineers and developers:

- Join the conversation on [GitHub Discussions](https://github.com/Sinh2022/Earlisthenic/discussions).
- Report anomalies via [GitHub Issues](https://github.com/Sinh2022/Earlisthenic/issues).
- Review our [Contributing Guidelines](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md).

---

## 📄 License

This project is open-source under the [MIT License](LICENSE).
Copyright © 2026 **Earlisthenic** / [Sinh2022](https://github.com/Sinh2022). All rights reserved.
