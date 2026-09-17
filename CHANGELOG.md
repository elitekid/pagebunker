# Changelog

## 1.1.0 — 2026-09-17

- Toolbar icon opens a popup panel (380×580) instead of saving immediately. The panel shows backup status, the current page (save / already saved / can't save), your five most recent articles with search, and links to the full library and settings. Opening the popup never saves by itself.
- Keyboard shortcut and right-click “Save this article” still save instantly and show a 4-second on-page toast (with Read now / Undo when possible). If the toast cannot be injected, the toolbar badge is used instead.
- Saving no longer opens the library tab automatically, including when you save the same article again.
- Right-click menu adds “Open PageBunker library”.
- Library shows “Loading library…” until the first article list arrives.
- Settings redesigned (TabBunker-style): auto-save, sticky header, section cards with switches and segment controls. Reading (mark read, theme), images, file backup with live status, import/restore shortcuts, keyboard shortcut row, about links, and delete-all with in-page confirmation.
- Library sticky header with backup status lines (file + in-browser snapshot), Back up now, and Restore from backup file. Removed dismissible welcome card; empty state shows import link when you have no articles.
- Replaced all `alert`/`confirm`/`prompt` with in-page dialogs and toast notifications.
- Shared button, input, card, switch, and segment styles in `theme.css`; reader toolbar uses the same button rules.
- Korean UI unified to 해요체.
- Library header adds Export: exports the selected articles, or the current list when nothing is selected.
- Delete all shows how many articles will be deleted and whether your backup file can restore them, with a Back up now button when it is out of date.
- Chrome and Edge: the downloads bar no longer pops up for automatic backups.
- Fixed: Open library, Restore, and Import in Settings did nothing; opening the library again now switches to the existing tab.

## 1.0.0 — Unreleased

- Save the article you are reading with the toolbar button, `Alt+Shift+L` (`Option+Shift+L` on Mac), or the right-click menu ("Save this article" / "이 글 저장").
- Extract title, author, publish date, and article body (paragraphs, headings, lists, quotes, code, tables) while leaving out ads, menus, and comments. Pages where the body cannot be extracted are saved as links only.
- Read saved articles offline, even after the original page is deleted. Adjust font size, line spacing, and width. Light and dark themes. Remembers reading position. Marks an article as read when you reach the end (can be turned off). Images are not loaded by default; click "Show images" in an article or turn them on in settings.
- Library with To read, Read, Archive, and Trash tabs. Articles in Trash are deleted automatically after 30 days. Sort, add tags, and select multiple articles at once.
- Search titles, sites, tags, and full article text in English and Korean. In our test with 1,000 articles, search finished within 0.34 seconds (Mac mini, Chrome).
- Import Pocket CSV export (unzip the downloaded file and choose the CSV), Pocket legacy HTML export, Instapaper CSV, and browser bookmarks HTML. Preview before importing. Each import can be undone as a whole. Imported items arrive as links; open the original page and save it to fill in the article body.
- Automatic backup to a PageBunker folder in your Downloads folder (`pagebunker-latest.json`, plus dated files, keeping the latest 7). The browser keeps the 3 most recent copies as well. Restore after reinstall with merge or replace; a replace can be undone once.
- Export selected articles as a single HTML file or as one Markdown file per article.
- No sign-up, no account, no server. No analytics, ads, or tracking code. The extension makes no network requests on its own.
- English and Korean interface. Chrome, Edge (same zip), and Firefox (separate zip).
