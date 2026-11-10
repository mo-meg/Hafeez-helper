## Context
The Settings page needed a more user‑friendly UI. The user chose a **sidebar navigation** layout for better discoverability and quicker access to sections.

## Approach
1. **Added a navigation sidebar** with links to each settings section (Account, Language, Data, Audio, Playback, Appearance, Reminders, Privacy, About).
2. **Re‑structured the Settings view** (`src/ui/views/settings.ts`):
   - Wrapped sections in a `settings-container` flex layout.
   - Introduced `settingsNav` helper to render the sidebar.
   - Kept existing section components unchanged, only changed their placement.
   - Preserved scroll‑to‑section behavior for deep links.
3. **Added responsive CSS** in `src/ui/styles.css` for the new layout, including a mobile‑friendly collapse to a horizontal nav.
4. Updated the view to generate the navigation items dynamically using translation keys for titles.

## Files Modified
- `src/ui/views/settings.ts` – implemented `settingsNav` and new layout.
- `src/ui/styles.css` – added `.settings-container`, `.settings-nav`, `.settings-content` styles and responsive rules.

## Verification
- Run `npm run build && npm start` and open `http://127.0.0.1:5173/#/settings`.
- The page now shows a persistent left‑hand navigation pane with clickable section titles.
- On mobile widths (`<860px`) the navigation collapses to a top horizontal scrollable bar.
- All existing functionality (download data, audio testing, etc.) remains intact.

## Next Steps
- Consider adding a search/filter input to the sidebar for even faster access.
- Add ARIA attributes to indicate the currently active section for improved accessibility.
- Write UI tests for the new layout.
