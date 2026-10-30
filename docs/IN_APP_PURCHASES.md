# One-time purchases

Gridbloom sells four one-time products and nothing else (no subscriptions).
They are checked directly with the stores by our own backend; no third-party
purchase service is used.

## Products

Create these with exactly these ids on every store you ship to.

| Product id | Type | Gives |
| --- | --- | --- |
| `premium_adventure_lifetime` | Non-consumable | Adventure levels 51–500 and all future levels |
| `remove_ads` | Non-consumable | No ads between games (rewarded ads stay) |
| `gems_40` | Consumable | 40 gems |
| `gems_120` | Consumable | 120 gems |

Suggested prices: Lifetime Unlock US $4.99, Remove Ads US $2.99, gems 40 US
$1.99, gems 120 US $4.99. Prices are set in each store, and the app shows the
store's own localised price.

## Setup per store

### Google Play
1. Play Console > Monetize > **In-app products**: create the four products
   (non-consumable = "one-time product", gems = consumable) and activate them.
2. Play Console > Setup > **API access**: link a Google Cloud project and a
   service account; grant it **View financial data** and **Manage orders and
   subscriptions**.
3. Put the service account JSON in the live `.env` as
   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (single line) or save it as
   `backend/google-play-service-account.json`.
4. Upload a build to an internal/closed testing track and add licence testers.
   In-app products can only be bought from a build installed from Play.

### App Store
1. App Store Connect > the app > **In-App Purchases**: create the products
   (non-consumable / consumable) with the ids above.
2. Users and Access > Integrations > **In-App Purchase** key: create a key and
   set `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY`
   (keep `\n` for newlines) and `APPLE_BUNDLE_ID`.
3. In Xcode add the **In-App Purchase** capability to the Runner target.

### Amazon Appstore (Fire tablets)
1. Developer console > In-App Items: create the products (entitlement /
   consumable) with the same SKUs.
2. Set `AMAZON_RVS_SHARED_SECRET` (Developer console > Settings > Security
   profile / shared key).
3. Build with `--dart-define=IS_FOR_AMAZON=true`. Google Play and iOS builds
   leave it unset.

## Backend endpoints (account required, guests get `LINK_ACCOUNT`)

| Endpoint | Purpose |
| --- | --- |
| `POST /api/purchases/verify` | Verify a purchase with the store and record it once |
| `GET /api/purchases/entitlements` | What the player owns + gem packs still to credit |
| `POST /api/purchases/claim` | The app credited these gem packs |

Safety rules built in:
- a purchase can only be recorded once (`platform + transaction id` is unique);
- `premium` and `removeAds` in the saved game data always come from verified
  purchases, never from what the app sends;
- unlocks are re-checked with the store about once a day, so a refund takes
  them away; an unreachable store never revokes anything;
- if the backend is down when a purchase completes, the app leaves the store
  transaction open and finishes it on the next launch, so nothing is lost.

Run the tests with `node --test test/purchases.test.js`.
