# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-06

### Added
- Branch-based brainstorming with parallel exploration
- Browser UI for answering questions
- Event-driven answer processing with `await_brainstorm_complete`
- Inline probe logic for automatic follow-up question generation
- User-configurable agent settings via `~/.config/opencode/octto.json`
- Question types: `pick_one`, `pick_many`, `confirm`, `ask_text`, `rank`, `rate`, `slider`, `thumbs`, `show_plan`, `show_options`, `show_diff`, `review_section`
- Dual session system (state persistence + browser WebSocket)
- Design document output to `docs/plans/`

### Security
- Input validation for all question configs (empty options, bounds checking)
- Whitelisted agent config overrides (only model, temperature, maxSteps)
- Session ID path traversal protection
