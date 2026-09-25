# Instagram cold DM lead lists

Each `<name>.json` here is a lead list the **Cold DMs** automation can work
through. Contact state (who was messaged, when, from which account, and
whether it failed) is written to `state/<name>.json`, which is git-ignored.

## Import a scraper export

```
npm run instagram:leads:import -- ~/Downloads/dataset_instagram-likes-scraper.json ig-likes-<postId> --exclude kevbuildsapps
```

Accepts Apify likes/followers scraper exports (arrays of user records with
`username`, `full_name`, `is_private`, `is_verified`) as well as this compact
format. Duplicate and malformed handles are dropped; `--exclude` removes your
own accounts.

## Run

In the device page, open **Cold DMs**, pick the list, set a batch size
(1–25) and whether to skip private accounts, and start. Each run pulls the
next uncontacted leads in list order and records the outcome per handle, so
runs can be repeated or scheduled until the list is exhausted. Handles that
failed are skipped on later runs unless `COLD_DMS_RETRY_FAILED=true` is set.

Runner env knobs: `COLD_DMS_LEAD_LIST`, `COLD_DMS_LEAD_BATCH`,
`COLD_DMS_SKIP_PRIVATE`, `COLD_DMS_RETRY_FAILED`, `COLD_DMS_BETWEEN_MS`,
`COLD_DMS_JITTER_MS`.
