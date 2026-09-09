# Data sources, attribution, and licenses

Tradewinds is a personal, non-commercial tool. Everything in `data/` and `test/fixtures/` is a
cached, reduced copy of publicly available data, kept so the app can start instantly and work
offline. None of it is private: Sleeper league state is readable by anyone who knows the league
id, and the value sources publish their numbers openly.

| Source | What is cached | Terms / license | Attribution |
|---|---|---|---|
| Sleeper (api.sleeper.app) | league settings, rosters, users, weekly projections, player list, NFL schedule | Public read-only API, no authentication | https://docs.sleeper.com/ |
| FantasyCalc (api.fantasycalc.com) | redraft and dynasty trade values (value, rank, trend, tier, roster %) | Public API | https://fantasycalc.com/ |
| DynastyProcess (github.com/dynastyprocess/data) | `values-players.csv` dynasty values, player-id crosswalk | **GPL-3.0** — the derived table `dp_dynasty` in `data/values.json` is redistributed under the same license | https://dynastyprocess.com/ |
| Boris Chen (borischen.co) | weekly half-PPR tier assignments | Public tier files | https://www.borischen.co/ |

Not used: KeepTradeCut (its terms of service prohibit scraping and derivative works) and any
paid or authenticated feed.

Player headshots and team logos are loaded at runtime from Sleeper's CDN and are not stored in
this repository.

The application code (everything outside `data/` and the third-party fixture copies) is
© 2026 Tom Bentley. The DynastyProcess-derived data table is licensed GPL-3.0 as noted above.
