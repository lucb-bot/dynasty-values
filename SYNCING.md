# Note on editing this project

`wrangler.toml` and `.github/workflows/*` hold values that only exist in the
deployed copy — the KV namespace id, and CI steps added after the fact. Copying
an older local snapshot over the repo has silently reverted both of these once,
producing an opaque "KV namespace is not valid" failure deep inside the
Cloudflare API.

If you edit this project somewhere other than the repo, copy individual files
across rather than unpacking a whole archive over it, and leave `wrangler.toml`
and `.github/` alone. The deploy workflow now fails fast with a clear message if
the KV placeholder reappears, but the workflow files themselves have no such
guard.
