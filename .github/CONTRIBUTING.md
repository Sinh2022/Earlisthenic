# Contributing to Earlisthenic

Thank you for your interest in improving Earlisthenic! We welcome contributions to our Linear-Phase Audio Engine, psychoacoustic exercises, and user experience.

## Development Workflow
1. **Repository Structure:**
   - Client Web App: Google Apps Script + Web Audio API.
   - Gateway & Docs: GitHub Pages branch `main`.
2. **Key Requirements:**
   - All user-facing UI text must remain strictly in English.
   - Code changes must preserve 100% pass rates across all automated test suites.
   - Never capture System Audio without explicit authorization.
   - Maintain linear-phase FIR filtering with zero-phase odd-tap convolution.

## Submitting Pull Requests
1. Fork the repository and create a descriptive feature branch.
2. Run test suites locally before committing:
   ```bash
   node tests/syntax.test.js
   node tests/logic_invariants.test.js
   node tests/run-tests.js
   node tests/e2e_dom.test.js
   ```
3. Open a Pull Request referencing related issues and describing changes in detail.
