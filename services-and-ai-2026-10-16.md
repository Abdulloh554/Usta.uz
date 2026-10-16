# Service catalog and admin assistant

The original six order categories are retained. Twenty specific services were
added: painting/wallpaper, tiling, plastering/drywall, carpentry, doors/windows,
air conditioning, appliance repair, computers/internet, furniture assembly/repair,
roofing, welding, masonry/concrete, flooring/parquet, heating/boilers, security
cameras/alarms, gardening, pest control, auto repair, tailoring and phone repair.

The scope follows the existing home-services marketplace and common local service
requests. Reference: https://www.ustabor.uz/uz/request and
https://home.ustabor.uz/uz/catalog. Regulated professional services such as legal
and medical advice were not added to the current master matching model.

Server validation, database enums, matching, master registration, admin category
filters/analytics and web/mobile labels support the same catalog. New services
use specific master specialties; existing trades are reused where appropriate.
New specialties require masters to select them in their profiles. The change
does not assume that new categories already have available specialists.

The home screen keeps six shortcuts. The new-job sheet shows all 26 services and
includes a translated search field. Labels are available in Uzbek, Russian and
English. Existing category IDs and orders remain compatible.

The admin assistant is at `/assistant`. It calls Groq from the API server using
`GROQ_API_KEY` and `GROQ_MODEL=openai/gpt-oss-120b`. The model was selected from
the authenticated provider's available model list and a live Uzbek response was
verified. The key belongs only in the server environment. Deploy API, admin,
web and mobile updates together; set the two variables on the deployed API and
restart it. No database migration is needed.

Assistant messages are limited, validated and rate limited. Statistics are
optional and aggregate only. The assistant produces text and cannot mutate
records. Chat history is held in memory, with the last ten messages sent for
context. Provider error bodies and credentials are not exposed to clients.
Provider reference: https://console.groq.com/docs/model/openai/gpt-oss-120b.

Validation:

- Full backend suite: 335 tests across 22 suites passed, including 42 new tests.
- All 26 categories were published through the API and matched against qualified
  versus unrelated masters using a temporary MongoDB replica set.
- AI tests cover admin access, input limits, history, statistics opt-in, missing
  key, provider failures and malformed responses.
- Server, admin, web and mobile TypeScript checks passed; server/web lint passed.
- Server and admin production builds passed.
- Admin browser checks passed at 1440px and 390px, including conversation history,
  statistics, clearing chat, overflow and browser errors. UI tests use mocked AI;
  provider connectivity was checked separately against Groq.
- The web production build is blocked in this Windows environment by the installed
  SWC native binding's cache ACL validation (`ERR_SWC_NATIVE_CACHE`). Web typecheck
  and lint pass; the web production bundle still needs verification in a working
  SWC environment before deployment.

Browser previews: `output/admin-assistant-desktop.png` and
`output/admin-assistant-mobile.png`. Repeat the local UI check with
`output/check-assistant-ui.py` while admin Vite runs on port 5179.
