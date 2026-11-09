# Wardrobe Manager

Adds a Vinted-style wardrobe manager with search, sorting, bulk listing actions and safe relisting as drafts across many Vinted country domains.

## What It Does
- Injects a “Relist as draft” button next to the “Booster” button on member wardrobe pages.
- Adds a “Wardrobe manager” panel with title search, selection and sorting by title, publication date, price, views or favourites.
- Loads the complete paginated wardrobe where the account endpoint exposes pagination, and keeps published, hidden and draft items in separate status groups.
- Finishes walking every available wardrobe page before applying the On sale filter, so later-page sold and hidden items are not misclassified as available.
- Stores snapshots only for items that have successfully been relisted. Existing backup records are synchronized against current Vinted details before another relist, retained while the listing is active, and removed when Vinted reports it as sold.
- Marks backed-up and previously relisted items in the manager, and displays the available publishing date, views and favourites.
- Shows a branded loading screen while every member wardrobe page is fetched before the manager menu appears.
- Uses conservative page pacing and retries temporary wardrobe responses with increasing backoff; it does not attempt to bypass Vinted anti-bot controls.
- Supports sequential bulk relisting, price changes, hiding, unhiding and deletion.
- Shows a dedicated bulk-relist progress dialog with item names, thumbnails, per-item status and current photo transfer progress while keeping the manager and compact activity toast available underneath.
- The Wardrobe manager launcher can be dragged to either side of the page and remembers its position; operation notices and errors remain fixed in the lower-right corner independently.
- On release, the launcher docks to the nearer screen edge with matching left/right rounded styling.
- The launcher keeps its full pill shape and one-line label while it is being dragged; edge styling is applied only after release.
- Analytics loads saved snapshots, keeps period and metric selections when changed, and maps the inventory-value metric to its stored history field.
- Items can be filtered as On sale, Drafts, Hidden or Sold; relisting is limited to eligible on-sale items so sold listings are not queued accidentally.
- On sale shows currently published items from the complete wardrobe scan; sold items remain available under Sold and are shown with a Sold badge.
- Backups are separate from availability: only successfully relisted items receive a backup badge, while an item can remain on sale without having been relisted.
- Supports fixed operation delays or random delays with a minimum of six seconds.
- Organizes the manager into Items, Relist queue, Drafts, Analytics, Log and Settings sections.
- Stores a persistent operation log with timestamps, operation types and result summaries.
- Shows lower-right relist activity notices and records detail copying, photo downloads/uploads, draft creation and optional deletion in the Log section.
- Provides an Analytics dashboard with period selectors, cached views/favourites/inventory charts, inventory KPIs and a selling-potential ranking.
- Shows each selling-potential item's cover photo before its title.
- Uses themed in-page dialogs for price changes, deletion and hide/unhide confirmation instead of browser prompt/confirm dialogs.
- Downloads photos from the existing item, re-uploads them, and creates a private draft with the same core fields (brand, size, category, price, etc.).
- Opens an in-page options menu before starting. By default, it deletes the original listing only after the draft is created successfully; it never calls the publish endpoint.
- Works across multiple Vinted TLDs (.fr, .de, .it, .es, .com, …). The code derives API calls from the current page’s `location.origin`.

## Important Warning
- Deleting the original listing is enabled by default in the options menu and cannot be undone. Uncheck it if you want to keep the original.
- If draft creation succeeds but deletion fails, the draft is kept and the original listing remains available. The extension reports this explicitly.
- The draft is never published automatically. You can review and publish it manually in Vinted.
- Network time is not controlled by the extension; the added pacing is capped, so total relist time may vary with Vinted and CDN response times.
- Bulk actions run one item at a time and report partial failures instead of hiding them.
- Relisting uses a small bounded pacing budget between detail preparation and photo download/upload steps to reduce burstiness without changing the draft-first safety flow.
- Relisting pauses for a randomized 1–1.5 seconds around each photo transfer, so photo-heavy items take longer without changing the upload order.
- Hide/unhide is marked experimental and requires an additional confirmation because its Vinted endpoint is unpublished.
- Manager-page styling is loaded from `wardrobe-manager.css`; popup styling remains in `popup.css`.

## Supported Domains
The manifest includes many Vinted country domains (FR, DE, IT, ES, PT, NL, BE, PL, CZ, SK, HU, RO, BG, LT, LV, EE, GR, SI, HR, IE, AT, CH, DK, SE, NO, FI, UK, COM). See `manifest.json` for the full list. Images are fetched from `images*.vinted.net` and `images*.vinted.com`.

## Install (Chrome / Edge)
1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable “Developer mode”.
3. Click “Load unpacked” and select this folder.
4. After changes, click “Reload” on the extension.

## Usage
- Click the extension icon and choose “Open wardrobe manager” to open the in-page manager menu.
- Navigate to your Vinted member wardrobe page, e.g. `https://www.vinted.de/member/<id>`.
- Find an item card that has a “Booster” button. A “Relist as draft” button should appear below it.
- If you Ctrl+click an item to open its focused item tab, the same “Relist as draft” action now appears under the “Bump” button on that page too.
- Click “Relist as draft”. The extension will:
  1) Show the options menu
  2) Gather item details and photos
  3) Create a private draft with the uploaded photos and copied fields
  4) Delete the original listing if the “Delete the old listing after the draft is created” option remains checked
  5) Refresh the page if selected
- On a member wardrobe page, click “Wardrobe manager” to select multiple items and run bulk actions.
- Use the left navigation to switch between the Items and Log views. The remaining sections are reserved for their upcoming wardrobe features.
- Drafts are displayed separately and are not passed to published-listing actions such as hide, delete or bulk price changes. Draft editing still follows Vinted’s separate editor workflow.
- The Relist queue, Drafts and Analytics views show the current in-session queue, draft cache and basic cached engagement totals.
- Analytics snapshots are stored locally when the dashboard is opened or refreshed. They are historical observations from the extension, not Vinted’s complete historical analytics feed.
- The Finance tab replaces the visible Relist queue tab and provides inventory value, a safe link to Vinted login, and an explicit limitation notice for wallet and historical sales data.
- Operation logs update while the manager is open and can be exported as JSON from the Log tab.
- Configure the operation delay in the manager:
  - Fixed delay: waits the same number of seconds between consecutive items in a bulk relist or update.
  - Random delay: chooses a new interval for each gap between items using the configured minimum and maximum; the minimum is always clamped to 5 seconds.
  - These controls do not delay a single-item action before it starts, and they do not publish drafts.
- Bulk price changes accept fixed or percentage adjustments such as `+2`, `-1.50`, `+10%`, `-15%`, or an exact price such as `=12.00`.

## Troubleshooting
- 403 or anti‑bot challenge (Cloudflare/DataDome): refresh the page, disable ad/tracker blockers for Vinted, and try again. Heavy rate limiting can also cause failures.
- “Relist as draft” button doesn’t appear: ensure you’re on a supported country domain and on a member wardrobe page. Reload the page and the extension.
- Photos fail to upload: network hiccups or CDN responses can fail intermittently—try again after a short pause.

## How It Works (Technical)
- `content.js` injects UI, reads the current page for CSRF when possible, and falls back to loading the new‑item page to extract the token. All API endpoints are built from `location.origin` to support any Vinted TLD.
- `background.js` listens to outgoing API requests on supported Vinted domains to capture tokens like `x-csrf-token` and `x-anon-id` for reuse.
- `manifest.json` enumerates supported domains for host permissions and content script matches.

## Permissions
- `activeTab`: to open the wardrobe manager from the extension popup.
- `scripting`: to inject the content script.
- `webRequest`: to observe request headers (CSRF/anon id capture).
- `storage`: to persist captured tokens between navigations.

## Notes & Limitations
- Site layout and APIs can change without notice, which may break the extension.
- Anti‑bot systems may block some requests unpredictably.
- Draft creation uses Vinted’s draft endpoint and does not call the draft completion/publish endpoint.
- Price changes use Vinted’s item-upload completion workflow and should be tested on a low-risk item before bulk use.
- Hide/unhide endpoints are internal Vinted endpoints and may change without notice. The extension reports failed requests per item.
- Draft discovery depends on the private draft-list endpoint being available to the signed-in account; if Vinted does not expose it, the manager still keeps published wardrobe loading separate and reports only drafts it can retrieve.
- Opening the manager can take longer on large wardrobes because the menu intentionally waits for all member-item pages instead of showing an incomplete list.
- If a wardrobe page continues to fail after retries, the manager stops and reports the page number rather than repeatedly requesting it.
- Browser extensions cannot safely create arbitrary folders on the user’s computer from a content script, so backups are kept in `chrome.storage.local` rather than a filesystem directory. This keeps the data available across sessions without storing Vinted cookies or passwords.
- Balance history, sales revenue and order history remain unavailable until Vinted exposes authenticated wallet/order responses to the extension. The Analytics page warns that the user must log in through the extension before those values can be accessed.
- The Log view keeps up to 300 recent local operation entries and can be cleared from the manager.

## Development
- Edit files and click “Reload” on the extension in `chrome://extensions`.
- To add another Vinted TLD, update both `host_permissions` and `content_scripts.matches` in `manifest.json`, and extend the URL filters in `background.js` if needed.